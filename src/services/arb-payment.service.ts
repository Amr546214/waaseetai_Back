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
/**
 * Everything the bank has not finally answered: open attempts, locally closed ones (CANCELLED / EXPIRED are OUR word, not the bank's) and an authorization the bank
 * still holds (AUTH_ONLY: nothing was captured and nothing was released). Each of these blocks a new start and keeps being reconciled.
 */
const UNRESOLVED: ArbPaymentStatus[] = [...OPEN, 'CANCELLED', 'EXPIRED', 'AUTH_ONLY'];
const MIN_NET_USD = 50;
const MAX_NET_USD = 100000;
/** a create call older than this with no answer is considered lost (the bank call itself times out at 20 s) */
const STALE_CREATE_MS = 90_000;
/** a return / poll may trigger one Inquiry per this many ms per attempt */
const INQUIRY_MIN_GAP_MS = 2_000;
/** an UNAUTHENTICATED webhook hint may wake the same attempt at most this often, and all hints together at most HINT_BUDGET_PER_MIN Inquiries a minute */
const HINT_MIN_GAP_MS = 15_000;
const HINT_BUDGET_PER_MIN = 30;
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
	/** kept for the wire shape: always false, there is no override */
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
	UNSETTLED: { message: 'لم نتأكد بعد من مصير عملية الدفع السابقة لدى البنك.', nextStep: 'قد تُحصَّل حتى لو غادرت صفحة البنك، ونضيف مبلغها إلى محفظتك تلقائيًا عند تأكيد البنك. لا يمكن بدء عملية جديدة قبل أن يحسم البنك العملية السابقة. اضغط «تحديث الحالة» أو عد لاحقًا.' },
	REVIEW: { message: 'لدى البنك تفويض قائم لعملية الدفع ولم يُحصَّل المبلغ، ولم يُضف أي مبلغ إلى محفظتك.', nextStep: 'لا تُعد الدفع. ننتظر إجراء البنك الصحيح لهذه الحالة (إنهاء التفويض أو تحصيله) ونوافيك بالنتيجة، ويمكنك التواصل مع الدعم برقم العملية.' },
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
		// 13-digit ms + 3 random digits = 16 digits: still an exact JS integer (< 2^53), so a bank that echoes the id as a JSON number cannot round it into another id
		return `${this.deps.now().getTime()}${String(randomInt(0, 1000)).padStart(3, '0')}`;
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
		const open = await this.db.arbPayment.findFirst({ where: { userId, status: { in: UNRESOLVED }, bankFinalAt: null }, orderBy: { createdAt: 'desc' } });
		if (!open) return null;
		return this.statusFor(userId, open.id);
	}

	/** Start (or resume) the one open card attempt of this user. */
	async initiate(userId: string, netUsd: number, customerIp: string): Promise<PublicArbView> {
		const cfg = this.requireReady(userId);
		if (!Number.isFinite(netUsd) || netUsd < MIN_NET_USD || netUsd > MAX_NET_USD) {
			throw new AppError(`المبلغ يجب أن يكون بين ${MIN_NET_USD} و ${MAX_NET_USD.toLocaleString('en-US')} دولار أمريكي`, 400);
		}
		if (!isPublicIp(customerIp)) {
			// the gateway declines a request without a real customer address (guide p.13). A private / loopback / missing address means the proxy
			// setting is wrong or the call is internal: refuse here with a clear reason instead of sending the bank a bad address.
			throw Object.assign(new AppError('تعذّر تحديد عنوانك لإتمام الدفع الآمن. حاول مرة أخرى.', 400), { code: 'CUSTOMER_IP_UNRELIABLE' });
		}
		const gate = await this.gate(userId);
		if (gate.block) return gate.block; // an attempt that can still be collected blocks a new one: no override, only the bank's answer lifts it

		const price = priceArbDeposit(netUsd, cfg.feePercent!, cfg.sarPerUsd);
		const net = price.net, fee = price.fee, gross = price.gross, amountSar = price.chargeSar;
		const rate = dec(cfg.sarPerUsd);
		const now = this.deps.now();

		let attempt: ArbPayment | null = null;
		for (let tries = 0; !attempt; tries++) {
			try {
				attempt = await this.db.arbPayment.create({
					data: {
						userId, trackId: this.newTrackId(), status: 'CREATED', netUsd: net, feeUsd: fee, feePercent: cfg.feePercent!, grossUsd: gross,
						fxSarPerUsd: rate, amountSar, currencyCode: cfg.currencyCode, customerIp,
						createdAt: now, expiresAt: new Date(now.getTime() + cfg.attemptTtlMin * 60_000),
					},
				});
			} catch (e) {
				if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
					// another start of the SAME user won the one-open-attempt index (double click / two tabs): answer with ITS state, never create a second
					const winner = await this.gate(userId);
					if (winner.block) return winner.block;
					// otherwise two different users drew the same track id in the same millisecond: draw again
					if (tries < 5 && /trackId|track_id/i.test(JSON.stringify((e.meta as any)?.target ?? e.message))) continue;
				}
				throw e;
			}
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
	 * May a new attempt start? Time is NOT evidence that the bank did not collect, and neither is our own call timeout: our 20 s timeout only ends OUR wait, the bank may keep
	 * processing the request. So an attempt is settled only by the bank's word (bankFinalAt): a result (paid / declined) or an error code the bank itself confirmed as
	 * «never collectable» (ARB_BANK_RELEASE_CODES, empty until the bank answers). There is NO user override (a ticked box is not a bank-backed way out).
	 *  - a page that is still live (REDIRECTED, inside its window) or a create call still in flight: show it, never a second one
	 *  - every other unsettled attempt (verifying, unconfirmed, no URL because the create answer was lost, locally cancelled / expired, authorization held by the bank): re-ask the
	 *    bank now; if it is still unsettled the new start is BLOCKED with the UNSETTLED state (message + «refresh status» in the UI) and the attempt stays reconciled.
	 *    An authorization the bank holds (APPROVED) blocks with the REVIEW state: it is neither money in the wallet nor permission to buy again.
	 *  - an attempt WITHOUT a payment id is blocked too: nobody HAS its page URL, but the bank may have created it and keep it payable; only the bank can say it does not exist.
	 */
	private async gate(userId: string): Promise<{ block: PublicArbView | null }> {
		const now = this.deps.now();
		const open = await this.db.arbPayment.findFirst({ where: { userId, status: { in: OPEN } }, orderBy: { createdAt: 'desc' } });
		if (open) {
			if (open.status === 'REDIRECTED' && open.expiresAt > now && open.paymentPageUrl) {
				// the page may already have a final answer at the bank (declined / paid): ask before offering the same page again
				const after = await this.verifyThrottled(open);
				if (after.status === 'REDIRECTED') return { block: this.view(after) };
				if (after.status === 'CAPTURED_APPLIED' || after.status === 'AUTH_ONLY') return { block: this.view(after) };
			}
			// a create call still in flight in another request (or just started): the user may be about to receive its page URL
			if ((open.status === 'CREATED' || open.status === 'CREATE_UNKNOWN') && now.getTime() - open.createdAt.getTime() < STALE_CREATE_MS) return { block: this.view(open) };
		}
		const prev = await this.db.arbPayment.findMany({ where: { userId, bankFinalAt: null, status: { in: UNRESOLVED } }, orderBy: { createdAt: 'desc' }, take: 5 });
		for (const row of prev) {
			const after = await this.verifyThrottled(row);
			if (after.status === 'CAPTURED_APPLIED' || after.status === 'AUTH_ONLY') return { block: this.view(after) };
			if (!after.bankFinalAt && UNRESOLVED.includes(after.status)) {
				return { block: this.view(after, { state: 'UNSETTLED', ...VIEW.UNSETTLED, redirectUrl: null, requiresAcknowledgement: false, previousReference: after.id }) };
			}
		}
		return { block: null };
	}

	async statusFor(userId: string, reference: string): Promise<PublicArbView> {
		const p = await this.db.arbPayment.findUnique({ where: { id: reference } });
		if (!p || p.userId !== userId) throw new AppError('عملية الدفع غير موجودة', 404);
		if (UNRESOLVED.includes(p.status) && !p.bankFinalAt && (p.bankPaymentId || p.status !== 'CREATED')) {
			try { return this.view(await this.verifyThrottled(p)); } catch (e) {
				if ((e as any)?.code !== 'ARB_NOT_AVAILABLE') throw e; // the rail was switched off: still show what we stored
			}
		}
		return this.view(p);
	}

	/** At most one Inquiry per INQUIRY_MIN_GAP_MS per attempt (a refreshing page or a hammered callback cannot flood the bank). */
	private async verifyThrottled(p: ArbPayment, minGapMs = INQUIRY_MIN_GAP_MS): Promise<ArbPayment> {
		if (p.lastInquiryAt && this.deps.now().getTime() - p.lastInquiryAt.getTime() < minGapMs) return p;
		return this.verify(p.id);
	}

	/** one Inquiry in flight per attempt: concurrent callers (poll + webhook + reconciler) share its answer instead of each calling the bank */
	private inflight = new Map<string, Promise<{ attempt: ArbPayment; notFound: boolean }>>();
	/** timestamps (ms) of Inquiries started because of an unauthenticated hint, for the global budget */
	private hintLog: number[] = [];
	private takeHintBudget(): boolean {
		const now = this.deps.now().getTime();
		this.hintLog = this.hintLog.filter(t => now - t < 60_000);
		if (this.hintLog.length >= HINT_BUDGET_PER_MIN) return false;
		this.hintLog.push(now);
		return true;
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
			where: { status: { in: UNRESOLVED }, bankFinalAt: null },
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

	/**
	 * Browser returned to responseURL: hint only. Find the attempt by the payment id (known only to the payer's browser and the bank), remember the arrival (VERIFYING = the
	 * user is no longer on the bank page; never money), then verify with the bank. Unlike the webhook, this request comes from the payer's own browser.
	 */
	async handleReturn(input: { paymentId?: unknown; trandata?: unknown; error?: unknown }): Promise<{ reference: string | null }> {
		const cfg = this.requireReady();
		const hint = readReturnTrandata(cfg, input.trandata);
		const paymentId = typeof input.paymentId === 'string' && /^\d{10,25}$/.test(input.paymentId) ? input.paymentId : hint?.paymentId ?? null;
		const trackId = hint?.trackId ?? null;
		const attempt = await this.findAttempt(paymentId, trackId);
		if (!attempt) return { reference: null };
		if (UNRESOLVED.includes(attempt.status) && !attempt.bankFinalAt) {
			await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: { in: ['REDIRECTED', 'UNCONFIRMED', 'CREATE_UNKNOWN'] } }, data: { status: 'VERIFYING' } });
			await this.verifyThrottled(await this.db.arbPayment.findUniqueOrThrow({ where: { id: attempt.id } }));
		}
		return { reference: attempt.id };
	}

	/** errorURL: the bank page ended with an error or the user left. Soft CANCELLED (our word only), then still ask the bank (money may have moved). */
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
	 * Merchant notification for Bank Hosted (guide p.187-194): body `[{paymentId, trandata}]`. The answer decides what the BANK does with the transaction: acknowledged = it keeps
	 * and settles it, not acknowledged = it VOIDS (p.187 step 4). So the answer is exact and does NOT wait for any Inquiry (the bank waits a configured time for it):
	 *  - ack only when the payload decrypts with our key, belongs to an attempt that can still be paid and matches its amount / ids / udf values (a purely local check + one write);
	 *  - the Inquiry that follows runs in the background and is only what moves money;
	 *  - a notification for an attempt we already declined / rejected is NOT acknowledged (the bank voids it, so nothing is collected that we would never credit).
	 * The redirect URL we hand back is always OUR configured response URL, never a value taken from the request.
	 */
	async handleNotification(input: { paymentId?: unknown; trandata?: unknown }): Promise<{ ack: boolean; responseUrl: string | null }> {
		const cfg = this.requireReady();
		const txn = readReturnTrandata(cfg, input.trandata);
		if (!txn) return { ack: false, responseUrl: null };
		const attempt = await this.findAttempt(txn.paymentId, txn.trackId);
		if (!attempt) return { ack: false, responseUrl: null };
		const bad = this.bindingProblem(attempt, txn);
		if (bad) {
			void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${attempt.trackId}`, metadata: { arbPaymentId: attempt.id, problem: bad } });
			return { ack: false, responseUrl: null };
		}
		if (attempt.status === 'DECLINED' || attempt.status === 'CREATE_REJECTED') {
			void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${attempt.trackId}`, metadata: { arbPaymentId: attempt.id, problem: 'notification_for_closed_attempt' } });
			return { ack: false, responseUrl: null };
		}
		// the acknowledgement is only sent once the arrival is durably recorded
		await this.db.arbPayment.updateMany({ where: { id: attempt.id, status: { in: ['REDIRECTED', 'UNCONFIRMED', 'CREATE_UNKNOWN'] } }, data: { status: 'VERIFYING', bankPaymentId: attempt.bankPaymentId ?? txn.paymentId } });
		if (!attempt.bankFinalAt) void this.verifyThrottled(await this.db.arbPayment.findUniqueOrThrow({ where: { id: attempt.id } })).catch(e => logger.error(`[ARB] verify after notification failed: ${(e as Error).message}`));
		return { ack: true, responseUrl: `${cfg.publicBaseUrl}/api/payments/arb/response` };
	}

	/**
	 * Webhook notification (guide p.179-186): a PLAIN (unencrypted, unsigned) JSON array `[{type, result:[{status,...}], responseURL, payLoad:[{...}]}]`; the merchant answers
	 * `[{"status":"1"}]`, and without it the gateway keeps resending (p.186) — there is NO void in this protocol. Nothing in it can be authenticated, so it is only a HINT:
	 *  - it NEVER changes an attempt's status and NEVER moves money (no status write at all); everything it says, including its own `responseURL`, is ignored;
	 *  - it can only ask «please check this known attempt», and that check is bounded: one Inquiry in flight per attempt (shared), at most one per HINT_MIN_GAP_MS per attempt,
	 *    at most HINT_BUDGET_PER_MIN for all hints together; beyond that the hint is dropped (the reconciler checks every unsettled attempt anyway);
	 *  - the acknowledgement does not wait for the check;
	 *  - ids are read exactly (trackId is a safe integer; a paymentId that arrived as a JSON number is ignored because it may have been rounded).
	 * ack=true for any readable body (known or unknown attempt: resending changes nothing); ack=false only for an unreadable body so the gateway retries.
	 */
	async handleWebhook(body: unknown): Promise<{ ack: boolean }> {
		this.requireReady();
		const asObj = (v: unknown): any => { const x = Array.isArray(v) ? v[0] : v; if (typeof x === 'string') { try { return asObj(JSON.parse(x)); } catch { return null; } } return x && typeof x === 'object' ? x : null; };
		const first = asObj(body);
		if (!first) return { ack: false };
		const rec = asObj(first.payLoad);
		if (!rec) return { ack: false };
		const trackRaw = rec.trackId, payRaw = rec.paymentId;
		const trackId = typeof trackRaw === 'string' || (typeof trackRaw === 'number' && Number.isSafeInteger(trackRaw)) ? String(trackRaw) : null;
		const paymentId = typeof payRaw === 'string' && /^\d{10,25}$/.test(payRaw) ? payRaw : null;
		if (!trackId && !paymentId) return { ack: false };
		const attempt = await this.findAttempt(paymentId, trackId);
		if (!attempt || attempt.bankFinalAt || !UNRESOLVED.includes(attempt.status)) return { ack: true }; // not ours / already settled: nothing to do
		if (attempt.lastInquiryAt && this.deps.now().getTime() - attempt.lastInquiryAt.getTime() < HINT_MIN_GAP_MS) return { ack: true }; // checked a moment ago
		if (!this.inflight.has(attempt.id) && !this.takeHintBudget()) return { ack: true }; // budget spent: the reconciler will get to it
		void this.verifyThrottled(attempt, HINT_MIN_GAP_MS).catch(e => logger.error(`[ARB] verify after webhook failed: ${(e as Error).message}`));
		return { ack: true };
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

	/** Same as verify, plus whether the bank answered "no such transaction" for an attempt that never received a payment id. One Inquiry per attempt at a time: concurrent callers share it. */
	verifyDetailed(id: string): Promise<{ attempt: ArbPayment; notFound: boolean }> {
		const running = this.inflight.get(id);
		if (running) return running;
		const p = this.verifyNow(id).finally(() => { this.inflight.delete(id); });
		this.inflight.set(id, p);
		return p;
	}

	private async verifyNow(id: string): Promise<{ attempt: ArbPayment; notFound: boolean }> {
		const cfg = this.requireReady();
		const a = await this.db.arbPayment.findUniqueOrThrow({ where: { id } });
		if (a.status === 'CAPTURED_APPLIED' || a.status === 'DECLINED' || a.status === 'CREATE_REJECTED') return { attempt: a, notFound: false };
		// an authorization is followed through the PAYMENT (a later capture is a different transaction with its own id), everything else by the transaction id once known
		const by: InquiryBy = a.bankTransId && a.status !== 'AUTH_ONLY' ? { by: 'TRANID', transId: a.bankTransId } : a.bankPaymentId ? { by: 'PaymentID', paymentId: a.bankPaymentId } : { by: 'TrackID', trackId: a.trackId };
		await this.db.arbPayment.update({ where: { id }, data: { inquiryCount: { increment: 1 }, lastInquiryAt: this.deps.now() } });
		const r = await inquire(cfg, this.deps.http, by, a.amountSar.toFixed(2), a.trackId);

		const done = async (attempt: Promise<ArbPayment>, notFound = false) => ({ attempt: await attempt, notFound });
		if (r.kind === 'UNKNOWN') return done(this.toUnconfirmed(a));
		if (r.kind === 'BANK_ERROR') {
			const code = (r.code ?? '').toUpperCase();
			// An error code settles an attempt ONLY if the bank itself confirmed that this code means «can never be collected» (ARB_BANK_RELEASE_CODES, empty by default).
			// IPAY0100042 («PaymentId Expired», guide p.274) is recorded but is NOT assumed to release anything: what it means for a payment that was already started is the bank's to say.
			const windowPassed = this.deps.now().getTime() - a.createdAt.getTime() > cfg.attemptTtlMin * 60_000; // a page that was never handed out is judged only after a full window AND the bank's confirmed code
			if (code && cfg.releaseCodes.includes(code) && UNRESOLVED.includes(a.status) && a.status !== 'AUTH_ONLY' && (a.bankPaymentId || windowPassed)) {
				const terminal: ArbPaymentStatus = a.bankPaymentId ? 'EXPIRED' : 'CREATE_REJECTED';
				await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: UNRESOLVED.filter(x => x !== 'AUTH_ONLY') } }, data: { status: terminal, bankFinalAt: this.deps.now(), bankResult: code } });
				return { attempt: await this.db.arbPayment.findUniqueOrThrow({ where: { id: a.id } }), notFound: !a.bankPaymentId };
			}
			return done(this.toUnconfirmed(a, code ? { bankResult: code } : {}), !a.bankPaymentId);
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
			// An authorization the bank HOLDS: not a capture (no wallet credit) and not a release either. bankFinalAt stays empty on purpose: the attempt keeps blocking a new purchase and keeps
			// being reconciled until the bank captures it (credited then), voids it (declined below) or the team finishes it with the bank. Only the first time raises the alert.
			const upd = await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: UNRESOLVED } }, data: { status: 'AUTH_ONLY', bankResult: word, bankTransId: t.transId ?? undefined, verifiedAt: this.deps.now() } });
			if (upd.count > 0 && a.status !== 'AUTH_ONLY') void notifyAdmins('SUSPICIOUS_PAYMENT', { ref: `ARB ${a.trackId}`, metadata: { arbPaymentId: a.id, problem: 'authorization_only' } });
			return done(this.db.arbPayment.findUniqueOrThrow({ where: { id } }));
		}
		if (word && DECLINE_WORD.test(word)) {
			await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: UNRESOLVED } }, data: { status: 'DECLINED', bankFinalAt: this.deps.now(), bankResult: word, verifiedAt: this.deps.now() } });
			return done(this.db.arbPayment.findUniqueOrThrow({ where: { id } }));
		}
		return done(this.toUnconfirmed(a, { bankResult: word || undefined }));
	}

	private async toUnconfirmed(a: ArbPayment, extra: Prisma.ArbPaymentUpdateManyMutationInput = {}): Promise<ArbPayment> {
		const now = this.deps.now();
		// a redirected attempt whose time ran out becomes EXPIRED (soft); everything else open stays/turns UNCONFIRMED. Never touches a terminal row.
		const next: ArbPaymentStatus = a.status === 'REDIRECTED' && a.expiresAt <= now ? 'EXPIRED'
			: a.status === 'REDIRECTED' ? 'REDIRECTED'
			: a.status === 'CANCELLED' || a.status === 'EXPIRED' || a.status === 'AUTH_ONLY' ? a.status
			: a.status === 'CREATE_UNKNOWN' || a.status === 'CREATED' ? a.status
			: 'UNCONFIRMED';
		await this.db.arbPayment.updateMany({ where: { id: a.id, status: { in: UNRESOLVED } }, data: { ...extra, status: next } });
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
