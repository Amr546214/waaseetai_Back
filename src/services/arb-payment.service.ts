import { randomInt } from 'crypto';
import { ArbPayment, ArbPaymentStatus, LogCategory, LogStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { isIP } from 'net';
import { priceArbDeposit } from '../utils/arb-pricing';
import { ArbConfig, arbAllowsUser, loadArbConfig, missingArbSettings } from '../config/arb.config';
import { ArbHttp, BankTxn, InquiryBy, createHostedPayment, fetchArbHttp, inquire, readReturnTrandata } from './arb-client';
import { CLIENT_ROUTES, ClientNotificationInput, clientNotifications } from './client-notifications.service';
import { notifyAdmins } from './admin-notifications.service';
import { logger } from '../config/logger';

/**
 * Wallet deposit by bank card through the ARB / Neoleap hosted payment page (Bank Hosted flow, guide p.16-31).
 * Rules this service enforces (each is covered by arb-payment.pg.test.ts on an isolated PostgreSQL with a SIMULATED bank):
 *  - the amount and currency are derived HERE from the requested net USD, the owner-approved rate and the fee class; the browser sends only the net amount
 *  - the browser coming back (responseURL / errorURL / a success page) is only a hint: money is applied after a server-to-server Inquiry (guide p.17 step 6)
 *  - only a verified CAPTURED purchase whose track id, payment id, amount, action code and echoed udf values match THIS attempt credits the wallet; APPROVED
 *    (authorization) is never treated as a capture
 *  - exactly-once: a conditional UPDATE (appliedAt IS NULL) + the unique wallet_transactions.referenceId inside ONE transaction; not an in-memory lock
 *  - at most one open attempt per user (partial unique index in the migration); a doubt (lost answer, no verdict) is checked with Inquiry before a new attempt
 *  - DECLINED / CAPTURED_APPLIED are terminal; CANCELLED / EXPIRED are soft (a later verified capture still wins, the bank may have taken the money)
 */

const OPEN: ArbPaymentStatus[] = ['CREATED', 'CREATE_UNKNOWN', 'REDIRECTED', 'VERIFYING', 'UNCONFIRMED'];
const MIN_NET_USD = 50;
const MAX_NET_USD = 100000;
/** a create call older than this with no answer is considered lost (the bank call itself times out at 20 s) */
const STALE_CREATE_MS = 90_000;
/** a return / poll may trigger one Inquiry per this many ms per attempt */
const INQUIRY_MIN_GAP_MS = 2_000;
/** result words the bank uses for "no money moved"; anything not in this list and not CAPTURED/APPROVED stays UNCONFIRMED (never guessed) */
const DECLINE_WORD = /^(NOT CAPTURED|DECLINED|DENIED.*|CANCEL(L)?ED|VOIDED|NOT APPROVED|FAILURE|FAILED|NOT PROCESSED|IPAY\d+.*)$/i;

export type PublicArbState = 'WAITING_PAGE' | 'VERIFYING' | 'PAID' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'REVIEW' | 'UNSETTLED';

export interface PublicArbView {
	reference: string;
	state: PublicArbState;
	message: string;
	nextStep: string;
	redirectUrl: string | null;
	creditedUsd: number | null;
	chargedSar: number | null;
	/** the bank itself gave a final answer for this attempt */
	bankFinal: boolean;
	/** a new attempt may only start if the user acknowledges that the previous one may still be collected */
	requiresAcknowledgement: boolean;
	previousReference: string | null;
}

const VIEW: Record<PublicArbState, { message: string; nextStep: string }> = {
	WAITING_PAGE: { message: 'أكمل الدفع في صفحة البنك.', nextStep: 'لا تغلق هذه الصفحة، وسنؤكد لك النتيجة تلقائيًا.' },
	VERIFYING: { message: 'جارٍ التحقق من الدفع مع البنك.', nextStep: 'لا تُعد الدفع الآن. سنؤكد لك النتيجة هنا، وقد يستغرق ذلك دقائق.' },
	PAID: { message: 'تم الدفع وإضافة المبلغ إلى محفظتك.', nextStep: 'يمكنك الآن استخدام الرصيد لتمويل مشروعك.' },
	DECLINED: { message: 'لم يقبل البنك عملية الدفع، ولم يُضف أي مبلغ إلى محفظتك.', nextStep: 'يمكنك المحاولة ببطاقة أخرى أو التواصل مع البنك المُصدر للبطاقة.' },
	CANCELLED: { message: 'لم تكتمل عملية الدفع.', nextStep: 'إن ظهر خصم على بطاقتك فسنؤكده تلقائيًا ويُضاف إلى محفظتك. يمكنك المحاولة من جديد بعد قليل.' },
	EXPIRED: { message: 'انتهت مهلة عملية الدفع قبل اكتمالها.', nextStep: 'إن ظهر خصم على بطاقتك فسنؤكده تلقائيًا. يمكنك بدء عملية جديدة.' },
	FAILED: { message: 'تعذّر بدء عملية الدفع بالبطاقة، ولم يُخصم أي مبلغ.', nextStep: 'حاول مرة أخرى بعد قليل، أو استخدم طريقة دفع أخرى.' },
	UNSETTLED: { message: 'لم نتأكد بعد من مصير عملية الدفع السابقة لدى البنك.', nextStep: 'قد تُحصَّل لاحقًا حتى لو غادرت صفحة البنك، ونضيف مبلغها إلى محفظتك تلقائيًا عند تأكيد البنك. لا تبدأ عملية جديدة إلا إذا كنت تقبل احتمال الخصم مرتين.' },
	REVIEW: { message: 'عملية الدفع قيد المراجعة لدينا.', nextStep: 'لا تُعد الدفع. سنراجعها ونوافيك بالنتيجة، ويمكنك التواصل مع الدعم برقم العملية.' },
};

function stateOf(s: ArbPaymentStatus): PublicArbState {
	switch (s) {
		case 'REDIRECTED': return 'WAITING_PAGE';
		case 'CREATED': case 'CREATE_UNKNOWN': case 'VERIFYING': case 'UNCONFIRMED': return 'VERIFYING';
		case 'CAPTURED_APPLIED': return 'PAID';
		case 'DECLINED': return 'DECLINED';
		case 'CANCELLED': return 'CANCELLED';
		case 'EXPIRED': return 'EXPIRED';
		case 'AUTH_ONLY': return 'REVIEW';
		default: return 'FAILED';
	}
}

const dec = (v: string | number) => new Prisma.Decimal(v);

export interface ArbDeps { prisma: typeof defaultPrisma; http: ArbHttp; config: () => ArbConfig; now: () => Date }

/** a public, routable address (what the gateway needs as the customer IP); loopback / private / link-local / unspecified are not */
export function isPublicIp(ip: string): boolean {
	const v = isIP(ip);
	if (!v) return false;
	if (v === 4) {
		const [a, b] = ip.split('.').map(Number);
		return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
	}
	const l = ip.toLowerCase();
	return !(l === '::' || l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff'));
}

class AlreadyClosed extends Error {}

export class ArbPaymentService {
	constructor(private deps: ArbDeps = { prisma: defaultPrisma, http: fetchArbHttp, config: () => loadArbConfig(), now: () => new Date() }) {}

	private get db() { return this.deps.prisma; }

	/** The browser only learns whether the rail exists; never why (settings names stay server-side). */
	isAvailable(userId?: string): boolean {
		const c = this.deps.config();
		return c.enabled && missingArbSettings(c).length === 0 && (userId === undefined || arbAllowsUser(c, userId));
	}

	/** userId given = the call is on behalf of a user and the rail must be open to THAT user (UAT: QA accounts only). */
	private requireReady(userId?: string): ArbConfig {
		const c = this.deps.config();
		if (userId !== undefined && c.enabled && missingArbSettings(c).length === 0 && !arbAllowsUser(c, userId)) {
			throw Object.assign(new AppError('الدفع بالبطاقة غير متاح لحسابك حاليًا.', 403), { code: 'ARB_NOT_AVAILABLE' });
		}
		if (!c.enabled || missingArbSettings(c).length > 0) {
			const miss = missingArbSettings(c);
			if (c.enabled && miss.length) logger.warn(`[ARB] enabled but not configured: ${miss.join(',')}`);
			throw Object.assign(new AppError('الدفع بالبطاقة غير متاح حاليًا.', 503), { code: 'ARB_NOT_AVAILABLE' });
		}
		return c;
	}

	private view(p: ArbPayment, extra: Partial<PublicArbView> = {}): PublicArbView {
		const state = stateOf(p.status);
		// a LOCAL cancel / expiry is not the bank's word: until the bank is final the user is told the payment may still be collected
		const warn = (state === 'CANCELLED' || state === 'EXPIRED') && !p.bankFinalAt
			? { message: 'أغلقنا المحاولة من جهتنا، لكن البنك لم يؤكد بعد أنها لن تُحصَّل.', nextStep: 'قد تُحصَّل إن أكملتها في صفحة البنك، ونضيف مبلغها إلى محفظتك تلقائيًا عند تأكيد البنك. لا تُعد الدفع قبل أن نؤكد لك.' } : {};
		return {
			reference: p.id, state, ...VIEW[state], ...warn,
			bankFinal: !!p.bankFinalAt, requiresAcknowledgement: false, previousReference: null,
			redirectUrl: p.status === 'REDIRECTED' ? p.paymentPageUrl : null,
			creditedUsd: p.status === 'CAPTURED_APPLIED' ? p.netUsd.toNumber() : null,
			chargedSar: p.status === 'CAPTURED_APPLIED' ? p.amountSar.toNumber() : null,
			...extra,
		};
	}

	private newTrackId(): string {
		return `${this.deps.now().getTime()}${String(randomInt(0, 100000)).padStart(5, '0')}`;
	}

	/** What a deposit would cost, derived exactly like initiate() does (read-only: no row, no bank call). Shown to the user BEFORE they are sent to the bank. */
	quote(userId: string, netUsd: number) {
		const cfg = this.requireReady(userId);
		if (!Number.isFinite(netUsd) || netUsd < MIN_NET_USD || netUsd > MAX_NET_USD) throw new AppError(`المبلغ يجب أن يكون بين ${MIN_NET_USD} و ${MAX_NET_USD.toLocaleString('en-US')} دولار أمريكي`, 400);
		const p = priceArbDeposit(netUsd, cfg.feePercent!, cfg.sarPerUsd);
		return { netUsd: p.net.toNumber(), feePercent: cfg.feePercent!, feeUsd: p.fee.toNumber(), grossUsd: p.gross.toNumber(), chargedSar: p.chargeSar.toNumber(), currency: 'SAR', sarPerUsd: cfg.sarPerUsd };
	}

	/** The user's open attempt (if any), brought to a verdict when the bank can give one. Lets a refreshed / reopened page pick up where it was. */
	async openAttemptFor(userId: string): Promise<PublicArbView | null> {
		if (!this.isAvailable(userId)) return null;
		const open = await this.db.arbPayment.findFirst({ where: { userId, status: { in: [...OPEN, 'CANCELLED', 'EXPIRED'] }, bankFinalAt: null, OR: [{ bankPaymentId: { not: null } }, { status: { in: OPEN } }] }, orderBy: { createdAt: 'desc' } });
		if (!open) return null;
		return this.statusFor(userId, open.id);
	}

	/** Start (or resume) the one open card attempt of this user. */
	async initiate(userId: string, netUsd: number, customerIp: string, opts: { acknowledgePreviousRisk?: boolean } = {}): Promise<PublicArbView> {
		const cfg = this.requireReady(userId);
		if (!Number.isFinite(netUsd) || netUsd < MIN_NET_USD || netUsd > MAX_NET_USD) {
			throw new AppError(`المبلغ يجب أن يكون بين ${MIN_NET_USD} و ${MAX_NET_USD.toLocaleString('en-US')} دولار أمريكي`, 400);
		}
		if (!isPublicIp(customerIp)) {
			// the gateway declines a request without a real customer address (guide p.13). A private / loopback / missing address means the proxy
			// setting is wrong or the call is internal: refuse here with a clear reason instead of sending the bank a bad address.
			throw Object.assign(new AppError('تعذّر تحديد عنوانك لإتمام الدفع الآمن. حاول مرة أخرى.', 400), { code: 'CUSTOMER_IP_UNRELIABLE' });
		}
		const gate = await this.gate(userId, !!opts.acknowledgePreviousRisk);
		if (gate.block) return gate.block;
		if (gate.supersedeIds.length) {
			// the user explicitly accepted the duplicate-charge risk: the earlier attempts leave the OPEN set LOCALLY (still unsettled at the bank, still reconciled, any later
			// capture is applied) so the one-open-attempt index lets the new one in
			await this.db.arbPayment.updateMany({ where: { id: { in: gate.supersedeIds }, status: { in: OPEN } }, data: { status: 'CANCELLED' } });
		}

		const price = priceArbDeposit(netUsd, cfg.feePercent!, cfg.sarPerUsd);
		const net = price.net, fee = price.fee, gross = price.gross, amountSar = price.chargeSar;
		const rate = dec(cfg.sarPerUsd);
		const now = this.deps.now();

		let attempt: ArbPayment;
		try {
			attempt = await this.db.arbPayment.create({
				data: {
					userId, trackId: this.newTrackId(), status: 'CREATED', netUsd: net, feeUsd: fee, feePercent: cfg.feePercent!, grossUsd: gross,
					fxSarPerUsd: rate, amountSar, currencyCode: cfg.currencyCode, customerIp,
					createdAt: now, expiresAt: new Date(now.getTime() + cfg.attemptTtlMin * 60_000), replacesId: gate.supersedeIds[0] ?? null,
				},
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
				// a concurrent start (double click / two tabs) won the one-open-attempt index: answer with ITS state, never create a second
				const winner = await this.gate(userId, false);
				if (winner.block) return winner.block;
			}
			throw e;
		}

		const result = await createHostedPayment(cfg, this.deps.http, {
			amountSar: amountSar.toFixed(2), trackId: attempt.trackId,
			responseUrl: `${cfg.publicBaseUrl}/api/payments/arb/response`, errorUrl: `${cfg.publicBaseUrl}/api/payments/arb/error`,
			customerIp, udf1: attempt.id, udf2: cfg.currencyCode, udf3: userId,
		});

		if (result.kind === 'OK') {
			const upd = await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: 'CREATED' }, data: { status: 'REDIRECTED', bankPaymentId: result.paymentId, paymentPageUrl: result.pageUrl } });
			if (upd.count === 0) logger.warn(`[ARB] attempt ${attempt.id} changed while the page URL was issued`);
		} else if (result.kind === 'REJECTED') {
			await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: 'CREATED' }, data: { status: 'CREATE_REJECTED', bankFinalAt: this.deps.now() } });
			logger.warn(`[ARB] bank refused attempt ${attempt.id} code=${result.code ?? 'none'}`);
		} else {
			await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: 'CREATED' }, data: { status: 'CREATE_UNKNOWN' } });
		}
		return this.view(await this.db.arbPayment.findUniqueOrThrow({ where: { id: attempt.id } }));
	}

	/**
	 * May a new attempt start? Time is NOT evidence that the bank did not collect: only the bank's own final answer (bankFinalAt) settles an attempt.
	 *  - a page that is still live (REDIRECTED, inside its window) or a create call still in flight: show it, never a second one
	 *  - an attempt WITHOUT a payment id (the user was never given a URL, so nothing can be paid): closed once it is older than our own bank-call timeout x3
	 *  - an attempt WITH a payment id that the bank has not finally answered (verifying, unconfirmed, locally cancelled / expired): re-ask the bank now; if still
	 *    unsettled the user gets a plain warning and must acknowledge the duplicate-charge risk before a new attempt starts. Nothing is ever started silently.
	 */
	private async gate(userId: string, acknowledge: boolean): Promise<{ block: PublicArbView | null; supersedeIds: string[] }> {
		const now = this.deps.now();
		const open = await this.db.arbPayment.findFirst({ where: { userId, status: { in: OPEN } }, orderBy: { createdAt: 'desc' } });
		if (open) {
			if (open.status === 'REDIRECTED' && open.expiresAt > now && open.paymentPageUrl) {
				// the page may already have a final answer at the bank (declined / paid): ask before offering the same page again
				const after = await this.verifyThrottled(open);
				if (after.status === 'REDIRECTED') return { block: this.view(after), supersedeIds: [] };
				if (after.status === 'CAPTURED_APPLIED' || after.status === 'AUTH_ONLY') return { block: this.view(after), supersedeIds: [] };
			}
			// a create call still in flight in another request (or just started): the user may be about to receive its page URL
			if ((open.status === 'CREATED' || open.status === 'CREATE_UNKNOWN') && now.getTime() - open.createdAt.getTime() < STALE_CREATE_MS) return { block: this.view(open), supersedeIds: [] };
		}
		// 1) attempts that never gave the user a URL: nothing can be paid on them
		const noUrl = await this.db.arbPayment.findMany({ where: { userId, status: { in: ['CREATED', 'CREATE_UNKNOWN'] }, bankPaymentId: null, createdAt: { lt: new Date(now.getTime() - STALE_CREATE_MS) } } }); // never a create that may still be in flight
		for (const a of noUrl) {
			const { attempt } = await this.verifyDetailed(a.id);
			if (attempt.status === 'CAPTURED_APPLIED') return { block: this.view(attempt), supersedeIds: [] };
			await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: ['CREATED', 'CREATE_UNKNOWN'] }, bankPaymentId: null }, data: { status: 'CREATE_REJECTED', bankFinalAt: now } });
		}
		// 2) attempts with a URL that the bank has not finally answered
		const prev = await this.db.arbPayment.findMany({ where: { userId, bankPaymentId: { not: null }, bankFinalAt: null, status: { in: [...OPEN, 'CANCELLED', 'EXPIRED'] } }, orderBy: { createdAt: 'desc' }, take: 5 });
		const unsettled: ArbPayment[] = [];
		for (const row of prev) {
			const after = await this.verifyThrottled(row);
			if (after.status === 'CAPTURED_APPLIED' || after.status === 'AUTH_ONLY') return { block: this.view(after), supersedeIds: [] };
			if (!after.bankFinalAt && [...OPEN, 'CANCELLED', 'EXPIRED'].includes(after.status)) unsettled.push(after);
		}
		if (unsettled.length === 0) return { block: null, supersedeIds: [] };
		if (!acknowledge) {
			const first = unsettled[0];
			return { block: this.view(first, { state: 'UNSETTLED', ...VIEW.UNSETTLED, redirectUrl: null, requiresAcknowledgement: true, previousReference: first.id }), supersedeIds: [] };
		}
		return { block: null, supersedeIds: unsettled.map(u => u.id) };
	}

	async statusFor(userId: string, reference: string): Promise<PublicArbView> {
		const p = await this.db.arbPayment.findUnique({ where: { id: reference } });
		if (!p || p.userId !== userId) throw new AppError('عملية الدفع غير موجودة', 404);
		if ((OPEN.includes(p.status) || p.status === 'CANCELLED' || p.status === 'EXPIRED') && (p.bankPaymentId || p.status !== 'CREATED')) {
			try { return this.view(await this.verifyThrottled(p)); } catch (e) {
				if ((e as any)?.code !== 'ARB_NOT_AVAILABLE') throw e; // the rail was switched off: still show what we stored
			}
		}
		return this.view(p);
	}

	/** At most one Inquiry per INQUIRY_MIN_GAP_MS per attempt (a refreshing page or a hammered callback cannot flood the bank). */
	private async verifyThrottled(p: ArbPayment): Promise<ArbPayment> {
		if (p.lastInquiryAt && this.deps.now().getTime() - p.lastInquiryAt.getTime() < INQUIRY_MIN_GAP_MS) return p;
		return this.verify(p.id);
	}

	/**
	 * The user says they left the bank page. That is a LOCAL cancel only: the bank may still collect on the page they left. Only a REDIRECTED attempt can be abandoned;
	 * it becomes the SOFT CANCELLED state, is asked about at once, and stays under reconciliation. A new attempt then needs the bank's final answer or the user's explicit
	 * acknowledgement of the duplicate-charge risk (see gate()). Never touches a paid / declined / verifying attempt.
	 */
	async abandon(userId: string, reference: string): Promise<PublicArbView> {
		const p = await this.db.arbPayment.findUnique({ where: { id: reference } });
		if (!p || p.userId !== userId) throw new AppError('عملية الدفع غير موجودة', 404);
		if (p.status !== 'REDIRECTED') return this.view(p);
		await this.db.arbPayment.updateMany({ where: { id: p.id, status: 'REDIRECTED' }, data: { status: 'CANCELLED' } });
		try { return this.view(await this.verify(p.id)); } catch { return this.view(await this.db.arbPayment.findUniqueOrThrow({ where: { id: p.id } })); }
	}

	/**
	 * Server-side reconciliation, independent of any browser or page: finds every attempt that is open or only locally closed and not yet finally answered by the bank, and asks it
	 * (Inquiry) with a back-off per attempt. Works after the browser was closed and after a server restart (it only reads the database).
	 * Safe to run on several instances or twice at once: verify() is idempotent and the credit is exactly-once by the database.
	 */
	async reconcileOnce(limit = 25): Promise<{ checked: number; applied: number }> {
		const cfg = this.deps.config();
		if (!cfg.enabled || missingArbSettings(cfg).length > 0) return { checked: 0, applied: 0 };
		const now = this.deps.now().getTime();
		const rows = await this.db.arbPayment.findMany({
			// no age cut-off: an attempt leaves this list only when the BANK gives a final answer (time is not evidence that nothing was collected)
			where: { status: { in: [...OPEN, 'CANCELLED', 'EXPIRED'] }, bankFinalAt: null },
			orderBy: [{ lastInquiryAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }], take: limit * 4, // never-checked attempts first, then the longest-waiting
		});
		let checked = 0, applied = 0;
		for (const a of rows) {
			if (checked >= limit) break;
			const age = now - a.createdAt.getTime();
			if (!a.bankPaymentId && age < STALE_CREATE_MS) continue; // a create still in flight
			const gap = age < 10 * 60_000 ? 30_000 : age < 3_600_000 ? 5 * 60_000 : age < 72 * 3_600_000 ? 30 * 60_000 : 24 * 3_600_000; // back-off only; never a stop
			if (a.lastInquiryAt && now - a.lastInquiryAt.getTime() < gap) continue;
			checked++;
			try { const r = await this.verify(a.id); if (r.status === 'CAPTURED_APPLIED') applied++; } catch (e) { logger.error(`[ARB] reconcile of ${a.id} failed: ${(e as Error).message}`); }
		}
		return { checked, applied };
	}

	// NOTE: CANCELLED / EXPIRED rows are never moved back to an OPEN state (VERIFYING): the user may already have a new open attempt, and the one-open-attempt
	// index would refuse the move. They are verified in place and only ever move to CAPTURED_APPLIED / DECLINED / AUTH_ONLY.

	/** Browser returned to responseURL: hint only. Find the attempt by the payment id, remember the arrival, then verify with the bank. */
	async handleReturn(input: { paymentId?: unknown; trandata?: unknown; error?: unknown }): Promise<{ reference: string | null }> {
		const cfg = this.requireReady();
		const hint = readReturnTrandata(cfg, input.trandata);
		const paymentId = typeof input.paymentId === 'string' && /^\d{10,25}$/.test(input.paymentId) ? input.paymentId : hint?.paymentId ?? null;
		const trackId = hint?.trackId ?? null;
		const attempt = await this.findAttempt(paymentId, trackId);
		if (!attempt) return { reference: null };
		if (OPEN.includes(attempt.status) || attempt.status === 'CANCELLED' || attempt.status === 'EXPIRED') {
			await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: { in: ['REDIRECTED', 'UNCONFIRMED', 'CREATE_UNKNOWN'] } }, data: { status: 'VERIFYING' } });
			await this.verifyThrottled(await this.db.arbPayment.findUniqueOrThrow({ where: { id: attempt.id } }));
		}
		return { reference: attempt.id };
	}

	/** errorURL: the bank page ended with an error or the user left. Soft CANCELLED, then still ask the bank (money may have moved). */
	async handleError(input: { paymentId?: unknown; trandata?: unknown }): Promise<{ reference: string | null }> {
		const cfg = this.requireReady();
		const hint = readReturnTrandata(cfg, input.trandata);
		const paymentId = typeof input.paymentId === 'string' && /^\d{10,25}$/.test(input.paymentId) ? input.paymentId : hint?.paymentId ?? null;
		const attempt = await this.findAttempt(paymentId, hint?.trackId ?? null);
		if (!attempt) return { reference: null };
		await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: { in: ['REDIRECTED', 'UNCONFIRMED'] } }, data: { status: 'CANCELLED' } });
		await this.verifyThrottled(await this.db.arbPayment.findUniqueOrThrow({ where: { id: attempt.id } }));
		return { reference: attempt.id };
	}

	/**
	 * Merchant notification (guide p.187-194). Returns true ONLY when it is safe for the bank to keep the transaction: the payload decrypts, belongs to a
	 * known attempt and matches its amount/ids. A mismatch returns false (no acknowledgement) and the bank voids the transaction (p.187 step 4).
	 */
	async handleNotification(input: { paymentId?: unknown; trandata?: unknown }): Promise<{ ack: boolean; responseUrl: string | null }> {
		const cfg = this.requireReady();
		if (!cfg.notificationEnabled) return { ack: false, responseUrl: null };
		const txn = readReturnTrandata(cfg, input.trandata);
		if (!txn) return { ack: false, responseUrl: null };
		const attempt = await this.findAttempt(txn.paymentId, txn.trackId);
		if (!attempt) return { ack: false, responseUrl: null };
		const bad = this.bindingProblem(attempt, txn);
		if (bad) {
			void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${attempt.trackId}`, metadata: { arbPaymentId: attempt.id, problem: bad } });
			return { ack: false, responseUrl: null };
		}
		// the acknowledgement is only sent once the arrival is durably recorded
		await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: { in: ['REDIRECTED', 'UNCONFIRMED', 'CREATE_UNKNOWN'] } }, data: { status: 'VERIFYING', bankPaymentId: attempt.bankPaymentId ?? txn.paymentId } });
		void this.verify(attempt.id).catch(e => logger.error(`[ARB] verify after notification failed: ${(e as Error).message}`));
		return { ack: true, responseUrl: `${cfg.publicBaseUrl}/api/payments/arb/response` };
	}

	private async findAttempt(paymentId: string | null, trackId: string | null): Promise<ArbPayment | null> {
		if (paymentId) { const a = await this.db.arbPayment.findUnique({ where: { bankPaymentId: paymentId } }); if (a) return a; }
		if (trackId && /^\d{10,30}$/.test(trackId)) return this.db.arbPayment.findUnique({ where: { trackId } });
		return null;
	}

	/** Every identifier the bank echoes must belong to THIS attempt; a missing optional echo is not a mismatch, a different one is. */
	private bindingProblem(a: ArbPayment, t: BankTxn): string | null {
		if (t.trackId !== null && t.trackId !== a.trackId) return 'track_id_mismatch';
		if (t.trackId === null && !a.bankPaymentId) return 'no_track_id';
		if (t.paymentId !== null && a.bankPaymentId && t.paymentId !== a.bankPaymentId) return 'payment_id_mismatch';
		if (t.udf1 !== null && t.udf1 !== a.id) return 'udf1_mismatch';
		if (t.udf2 !== null && t.udf2 !== a.currencyCode) return 'currency_mismatch';
		if (t.udf3 !== null && t.udf3 !== a.userId) return 'user_mismatch';
		if (t.amt === null) return 'amount_missing';
		try { if (!dec(t.amt).equals(a.amountSar)) return 'amount_mismatch'; } catch { return 'amount_unreadable'; }
		if (t.actionCode !== null && t.actionCode !== '1') return 'not_a_purchase';
		return null;
	}

	/** Ask the bank (Inquiry) and move the attempt accordingly. Safe to call any number of times, from any path, in any order. */
	async verify(id: string): Promise<ArbPayment> {
		return (await this.verifyDetailed(id)).attempt;
	}

	/** Same as verify, plus whether the bank answered "no such transaction" for an attempt that never received a payment id (closes a lost create safely). */
	async verifyDetailed(id: string): Promise<{ attempt: ArbPayment; notFound: boolean }> {
		const cfg = this.requireReady();
		const a = await this.db.arbPayment.findUniqueOrThrow({ where: { id } });
		if (a.status === 'CAPTURED_APPLIED' || a.status === 'DECLINED' || a.status === 'CREATE_REJECTED') return { attempt: a, notFound: false };
		const by: InquiryBy = a.bankTransId ? { by: 'TRANID', transId: a.bankTransId } : a.bankPaymentId ? { by: 'PaymentID', paymentId: a.bankPaymentId } : { by: 'TrackID', trackId: a.trackId };
		await this.db.arbPayment.update({ where: { id }, data: { inquiryCount: { increment: 1 }, lastInquiryAt: this.deps.now() } });
		const r = await inquire(cfg, this.deps.http, by, a.amountSar.toFixed(2), a.trackId);

		const done = async (attempt: Promise<ArbPayment>, notFound = false) => ({ attempt: await attempt, notFound });
		if (r.kind === 'UNKNOWN') return done(this.toUnconfirmed(a));
		if (r.kind === 'BANK_ERROR') {
			// the bank says the payment id itself has expired (guide p.274 IPAY0100042): no page can still be completed, so nothing can be collected on it. This is the bank's
			// own final word (not our clock) and the only error that settles an attempt that has a URL.
			if (a.bankPaymentId && (r.code === 'IPAY0100042' || /payment\s*id\s*expired/i.test(r.text ?? ''))) {
				await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: OPEN.concat(['CANCELLED', 'EXPIRED']) } }, data: { status: 'EXPIRED', bankFinalAt: this.deps.now() } });
				return { attempt: await this.db.arbPayment.findUniqueOrThrow({ where: { id: a.id } }), notFound: false };
			}
			// the bank could not find / read the transaction: that is NOT a decline. For an attempt that never got a page URL it means nothing exists.
			return done(this.toUnconfirmed(a), !a.bankPaymentId);
		}
		const t = r.txn;
		const problem = this.bindingProblem(a, t);
		if (problem) {
			void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${a.trackId}`, metadata: { arbPaymentId: a.id, problem } });
			logger.warn(`[ARB] attempt ${a.id} not applied: ${problem}`);
			return done(this.toUnconfirmed(a, { bankResult: t.result ?? undefined }));
		}
		const word = (t.result || '').trim();
		if (/^CAPTURED$/i.test(word)) {
			if (!t.transId) return done(this.toUnconfirmed(a));
			return done(this.applyCapture(a, t));
		}
		if (/^APPROVED$/i.test(word)) {
			await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: OPEN.concat(['CANCELLED', 'EXPIRED']) } }, data: { status: 'AUTH_ONLY', bankFinalAt: this.deps.now(), bankResult: word, bankTransId: t.transId ?? undefined, verifiedAt: this.deps.now() } });
			void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${a.trackId}`, metadata: { arbPaymentId: a.id, problem: 'authorization_only' } });
			return done(this.db.arbPayment.findUniqueOrThrow({ where: { id } }));
		}
		if (word && DECLINE_WORD.test(word)) {
			await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: OPEN.concat(['CANCELLED', 'EXPIRED']) } }, data: { status: 'DECLINED', bankFinalAt: this.deps.now(), bankResult: word, verifiedAt: this.deps.now() } });
			return done(this.db.arbPayment.findUniqueOrThrow({ where: { id } }));
		}
		return done(this.toUnconfirmed(a, { bankResult: word || undefined }));
	}

	private async toUnconfirmed(a: ArbPayment, extra: Prisma.ArbPaymentUpdateManyMutationInput = {}): Promise<ArbPayment> {
		const now = this.deps.now();
		// a redirected attempt whose time ran out becomes EXPIRED (soft); everything else open stays/turns UNCONFIRMED. Never touches a terminal row.
		const next: ArbPaymentStatus = a.status === 'REDIRECTED' && a.expiresAt <= now ? 'EXPIRED'
			: a.status === 'REDIRECTED' ? 'REDIRECTED'
			: a.status === 'CANCELLED' || a.status === 'EXPIRED' ? a.status
			: a.status === 'CREATE_UNKNOWN' || a.status === 'CREATED' ? a.status
			: 'UNCONFIRMED';
		await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: OPEN.concat(['CANCELLED', 'EXPIRED']) } }, data: { ...extra, status: next } });
		return this.db.arbPayment.findUniqueOrThrow({ where: { id: a.id } });
	}

	/** The single place that credits the wallet. One transaction: claim (appliedAt IS NULL) + wallet row (unique referenceId) + balance + audit + notification. */
	private async applyCapture(a: ArbPayment, t: BankTxn): Promise<ArbPayment> {
		const refId = `arb:${t.transId}`;
		let notificationId: string | null = null;
		try {
			await this.db.$transaction(async tx => {
				// 1) the money record first (unique referenceId = the exactly-once guard across ALL rails); 2) the claim carries its id, so the table CHECK
				// (applied => appliedAt + walletTxId + bankTransId) holds in the same statement. A lost claim throws and rolls the wallet row back.
				const wtx = await tx.walletTransaction.create({
					data: {
						userId: a.userId, type: 'DEPOSIT', amount: a.netUsd.toNumber(), currency: 'USD', status: 'COMPLETED', paymentMethod: 'ARB_CARD', referenceId: refId,
						description: 'إيداع رصيد بالمحفظة بالبطاقة (البنك)',
						metadata: { arbPaymentId: a.id, trackId: a.trackId, bankTransId: t.transId, netCredited: a.netUsd.toNumber(), grossUsd: a.grossUsd.toNumber(), feeUsd: a.feeUsd.toNumber(), feePercent: a.feePercent, chargedSar: a.amountSar.toNumber(), currencyCode: a.currencyCode, fxSarPerUsd: a.fxSarPerUsd.toNumber(), cardType: t.cardType },
					},
				});
				const claim = await tx.arbPayment.updateMany({
					where: { id: a.id, appliedAt: null, status: { notIn: ['CAPTURED_APPLIED', 'DECLINED', 'CREATE_REJECTED'] } },
					data: { status: 'CAPTURED_APPLIED', appliedAt: this.deps.now(), verifiedAt: this.deps.now(), bankTransId: t.transId, bankRef: t.ref, bankResult: 'CAPTURED', bankAuthCode: t.authCode, bankCardType: t.cardType, bankPaymentId: a.bankPaymentId ?? t.paymentId, walletTxId: wtx.id, bankFinalAt: this.deps.now() },
				});
				if (claim.count === 0) throw new AlreadyClosed(); // someone else applied / closed it: roll back our wallet row, nothing duplicated
				await tx.user.update({ where: { id: a.userId }, data: { walletBalance: { increment: a.netUsd.toNumber() } } });
				await tx.accountAuditLog.create({
					data: {
						userId: a.userId, category: LogCategory.SYSTEM_AUDIT, title: 'إيداع رصيد بالمحفظة', actionText: `إيداع ${a.netUsd.toFixed(2)} دولار (صافي) بالبطاقة، المحصّل ${a.amountSar.toFixed(2)} ريال`,
						status: LogStatus.COMPLETED, statusText: 'مكتمل بنجاح', summary: `تم شحن المحفظة بصافي ${a.netUsd.toFixed(2)} دولار - رقم عملية البنك: ${t.transId}`, source: 'USER', eventType: 'WALLET_DEPOSIT_COMPLETED', severity: 'INFO',
					},
				});
				const note: ClientNotificationInput = {
					userId: a.userId, title: 'تم إيداع الرصيد بنجاح', message: `أُضيف مبلغ ${a.netUsd.toFixed(2)} دولار إلى رصيد محفظتك عبر الدفع بالبطاقة.`, type: 'FINANCIAL',
					category: 'FINANCIAL' as any, actionUrl: CLIENT_ROUTES.wallet, actionText: 'عرض المحفظة', metadata: { transactionId: wtx.id },
				};
				notificationId = (await tx.notification.create({ data: note as any })).id;
			});
		} catch (e) {
			if (e instanceof AlreadyClosed) return this.db.arbPayment.findUniqueOrThrow({ where: { id: a.id } });
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
				// the unique wallet reference / bank transaction id already exists: it was credited (or the id belongs to another row) — never credit twice
				const now = await this.db.arbPayment.findUniqueOrThrow({ where: { id: a.id } });
				if (now.status !== 'CAPTURED_APPLIED') {
					void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${a.trackId}`, metadata: { arbPaymentId: a.id, problem: 'bank_transaction_id_already_used' } });
					return this.toUnconfirmed(now);
				}
				return now;
			}
			throw e; // a database failure: nothing was committed, the attempt stays open and the next verify retries
		}
		if (notificationId) await clientNotifications.deliverStored([notificationId]);
		return this.db.arbPayment.findUniqueOrThrow({ where: { id: a.id } });
	}
}

export const arbPaymentService = new ArbPaymentService();

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
/** Starts the periodic reconciliation (60 s). No-op unless the rail is enabled and fully configured. */
export function startArbReconciler(): boolean {
	if (reconcileTimer || !arbPaymentService.isAvailable()) return false;
	reconcileTimer = setInterval(() => { arbPaymentService.reconcileOnce().catch(e => logger.error(`[ARB] reconcile run failed: ${(e as Error).message}`)); }, 60_000);
	reconcileTimer.unref();
	return true;
}
