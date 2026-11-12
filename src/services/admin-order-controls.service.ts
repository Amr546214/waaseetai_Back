import { createHash } from 'node:crypto';
import { AmendmentStatus, CancellationRequestStatus, ContractStatus, EscrowStatus, NotificationCategory, Prisma, ProjectStatus, ProposalStatus, RequestStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AppError } from '../utils/app-error';
import { round2 } from '../utils/money';
import { isV2Escrow, splitRelease } from '../utils/escrow-commission';
import { ADMIN_CONTROL_REASONS, AdminControlAction, AdminControlReason, adminControlMessage } from '../constants/admin-controls';
import { AdminActor, actorHas } from './admin-access.service';
import { adminAudit } from './admin-audit.service';
import { heldEscrowAmount } from './dispute.service';
import { ACTIVE_DISPUTE_STATUSES, lockProjectForFreezeCheck } from './dispute-freeze.service';
import { notificationService, CreateNotificationInput } from './notification.service';
import { CLIENT_ROUTES } from './client-notifications.service';
import { PROVIDER_ROUTES } from './provider-notifications.service';

/**
 * Admin control over requests, offers, contracts and escrow.
 *
 *  - ONE rule table per entity (`evalRequest` / `evalOffer` / `evalContract`): the availability read model (GET .../controls), the quote and the action itself all call the same function, so
 *    the screen can never offer what the server would refuse, and the server re-checks everything inside the transaction under row locks;
 *  - every mutation: Idempotency-Key (stored INSIDE the transaction, same key + same request = the stored result, same key + other request = 409), expectedVersion (optimistic check under the lock),
 *    a mandatory reason, the audit row written in the SAME transaction (a failed audit rolls everything back), and notifications only AFTER the commit (best effort, never fail the action);
 *  - money moves only through the same mechanics as the financial dispute decision / agreed-cancellation settlement (escrow row conditional update, wallet row + WalletTransaction with a unique
 *    referenceId, commission via the escrow's own snapshot): nothing here decides a split or a commission that the code / fee policy does not already define. A plain cancellation NEVER decides held money: while the escrow holds a balance it is refused with CANCELLATION_SETTLEMENT_NOT_APPROVED (the settlement rule is not approved by the product); the explicit refund and release actions are the separate, previewed money decisions.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
const REASON_MIN = 5, REASON_MAX = 500;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,120}$/;
const LIVE_OFFER: ProposalStatus[] = [ProposalStatus.PENDING, ProposalStatus.SUBMITTED, ProposalStatus.UNDER_NEGOTIATION];
const OPEN_OFFER_STATUSES: ProposalStatus[] = [ProposalStatus.PENDING, ProposalStatus.SUBMITTED, ProposalStatus.UNDER_NEGOTIATION, ProposalStatus.IN_AI_REVIEW, ProposalStatus.PENDING_SIGNATURE];
const CLOSED_CONTRACT: ContractStatus[] = [ContractStatus.COMPLETED, ContractStatus.CANCELLED];
const TX_OPTIONS = { maxWait: 5000, timeout: 20000 } as const;

export class AdminControlError extends AppError {}
// the two authority refusals carry the SAME codes the route guards use (ADMIN_PERMISSION_DENIED / ADMIN_SUPER_ADMIN_REQUIRED), so the FE has one mapping
const WIRE_CODE: Partial<Record<AdminControlReason, string>> = { PERMISSION_DENIED: 'ADMIN_PERMISSION_DENIED', SUPER_ADMIN_REQUIRED: 'ADMIN_SUPER_ADMIN_REQUIRED' };
const wire = (code: AdminControlReason): string => WIRE_CODE[code] ?? code;
const fail = (code: AdminControlReason, status = 409, errors?: any[]) => new AdminControlError(adminControlMessage(code), status, errors, wire(code));
const blockOf = (code: AdminControlReason, status = 409) => ({ code, message: adminControlMessage(code), status });
type Block = ReturnType<typeof blockOf>;

/** Delivery of the after-commit notifications. A test replaces it with a stub; production uses the established notification service (stored row + the user's saved channels). */
export const adminControlDeps = {
	notify: async (input: CreateNotificationInput): Promise<unknown> => notificationService.createAndEmit(input),
	/** test seam: runs inside the money transaction after the money moved; a throw must leave NOTHING moved */
	afterMoney: undefined as undefined | (() => Promise<void> | void),
};

const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null) => `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || null;
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : '-');

// ───────────────────────── input validation ─────────────────────────
export function cleanReason(raw: unknown, required = true): string | null {
	const t = typeof raw === 'string' ? raw.trim() : '';
	if (!t) { if (required) throw fail('REASON_REQUIRED', 400, [{ field: 'reason', path: 'reason', message: adminControlMessage('REASON_REQUIRED') }]); return null; }
	if (t.length < REASON_MIN) throw fail('REASON_REQUIRED', 400, [{ field: 'reason', path: 'reason', message: adminControlMessage('REASON_REQUIRED') }]);
	if (t.length > REASON_MAX) throw fail('REASON_TOO_LONG', 400, [{ field: 'reason', path: 'reason', message: adminControlMessage('REASON_TOO_LONG') }]);
	return t;
}
export function cleanKey(raw: unknown): string {
	const k = typeof raw === 'string' ? raw.trim() : '';
	if (!KEY_RE.test(k)) throw fail('IDEMPOTENCY_KEY_REQUIRED', 400);
	return k;
}
const cleanVersion = (raw: unknown): string => {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v || v.length > 64) throw fail('VERSION_REQUIRED', 400, [{ field: 'expectedVersion', path: 'expectedVersion', message: adminControlMessage('VERSION_REQUIRED') }]);
	return v;
};
const cleanMoney = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? round2(raw) : null);

// ───────────────────────── world (one consistent read of a request and everything attached to it) ─────────────────────────
interface World {
	projectId: string;
	request: any | null; project: any | null; contract: any | null; escrow: any | null; offers: any[];
	activeDisputes: number; agreedCancellation: boolean; openCancellations: number; openAmendments: number;
	held: number;
}

const ROW_LOCK = {
	request: (tx: Tx, id: string) => tx.$queryRaw`SELECT "id" FROM "client_requests" WHERE "id" = ${id} FOR UPDATE`,
	contract: (tx: Tx, projectId: string) => lockProjectForFreezeCheck(tx, projectId),
	offers: (tx: Tx, projectId: string) => tx.$queryRaw`SELECT "id" FROM "project_proposals" WHERE "projectId" = ${projectId} FOR UPDATE`,
};

async function loadWorld(db: Db, projectId: string): Promise<World> {
	const request = await db.clientRequest.findUnique({ where: { id: projectId }, include: { clientProfile: { select: { userId: true, user: { select: { id: true, firstName: true, lastName: true } } } } } });
	const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, status: true, clientId: true, providerId: true } });
	const contract = await db.contract.findUnique({ where: { projectId }, include: { client: { select: { id: true, firstName: true, lastName: true } }, provider: { select: { id: true, firstName: true, lastName: true } } } });
	const escrow = await db.escrow.findUnique({ where: { projectId } });
	const offers = await db.projectProposal.findMany({ where: { projectId }, select: { id: true, providerId: true, status: true, totalPrice: true, adminSuspendedAt: true, adminSuspendReason: true, updatedAt: true, createdAt: true } });
	const activeDisputes = await db.dispute.count({ where: { OR: [{ projectId }, { requestId: projectId }], status: { in: ACTIVE_DISPUTE_STATUSES } } });
	let agreedCancellation = false, openCancellations = 0, openAmendments = 0;
	if (contract) {
		agreedCancellation = !!(await db.contractCancellationRequest.findFirst({ where: { contractId: contract.id, status: CancellationRequestStatus.AGREED_PENDING_SETTLEMENT }, select: { id: true } }));
		openCancellations = await db.contractCancellationRequest.count({ where: { contractId: contract.id, status: CancellationRequestStatus.PENDING_OTHER_PARTY } });
		openAmendments = await db.projectAmendment.count({ where: { contractId: contract.id, status: AmendmentStatus.PENDING_OTHER_PARTY } });
	}
	const held = escrow ? round2(heldEscrowAmount(escrow, contract?.price) ?? 0) : 0;
	return { projectId, request, project, contract, escrow, offers, activeDisputes, agreedCancellation, openCancellations, openAmendments, held };
}

// optimistic versions: change whenever something that decides the action changes
const requestVersion = (w: World) => sha([iso(w.request?.updatedAt), w.request?.status, iso(w.request?.adminSuspendedAt), w.contract?.status, iso(w.contract?.updatedAt), iso(w.contract?.adminFrozenAt), w.escrow?.status, w.escrow?.releasedAmount, iso(w.escrow?.updatedAt)].join('|')).slice(0, 32);
const contractVersion = (w: World) => sha([iso(w.contract?.updatedAt), w.contract?.status, iso(w.contract?.adminFrozenAt), w.escrow?.status, w.escrow?.amount, w.escrow?.releasedAmount, iso(w.escrow?.updatedAt), w.request?.status].join('|')).slice(0, 32);
const offerVersion = (w: World, offerId: string) => { const o = w.offers.find(x => x.id === offerId); return sha([iso(o?.updatedAt), o?.status, iso(o?.adminSuspendedAt), w.request?.status, w.contract?.status].join('|')).slice(0, 32); };

// ───────────────────────── rule tables (pure) ─────────────────────────
type ActorView = { isSuperAdmin: boolean; has: (id: string) => boolean };
const viewOf = (a: AdminActor): ActorView => ({ isSuperAdmin: a.isSuperAdmin, has: id => a.isSuperAdmin || actorHas(a, id) });

export function evalRequest(action: 'REQUEST_SUSPEND' | 'REQUEST_RESUME' | 'REQUEST_CANCEL', w: World, actor: ActorView): Block | null {
	if (!actor.has('requests.manage')) return blockOf('PERMISSION_DENIED', 403);
	const r = w.request;
	if (!r) return blockOf('NOT_FOUND', 404);
	const status = String(r.status);
	if (action === 'REQUEST_CANCEL') {
		if (status === 'CANCELLED') return blockOf('REQUEST_ALREADY_CANCELLED');
		if (status === 'COMPLETED') return blockOf('REQUEST_COMPLETED');
		if (status === 'DRAFT') return blockOf('REQUEST_DRAFT');
		if (w.contract) return evalContract('CONTRACT_CANCEL', w, actor, true);
		return null;
	}
	if (action === 'REQUEST_SUSPEND') {
		if (status === 'CANCELLED') return blockOf('REQUEST_ALREADY_CANCELLED');
		if (status === 'COMPLETED') return blockOf('REQUEST_COMPLETED');
		if (status === 'DRAFT') return blockOf('REQUEST_DRAFT');
		if (r.adminSuspendedAt) return blockOf('REQUEST_ALREADY_SUSPENDED');
		if (w.contract) return blockOf('REQUEST_HAS_CONTRACT');
		if (status !== 'OPEN') return blockOf('REQUEST_NOT_OPEN');
		return null;
	}
	if (!r.adminSuspendedAt) return blockOf('REQUEST_NOT_SUSPENDED');
	if (status === 'CANCELLED') return blockOf('REQUEST_ALREADY_CANCELLED');
	if (status !== 'OPEN') return blockOf('REQUEST_NOT_OPEN');
	return null;
}

export function evalOffer(action: 'OFFER_SUSPEND' | 'OFFER_RESUME', w: World, offerId: string, actor: ActorView): Block | null {
	if (!actor.has('offers.manage')) return blockOf('PERMISSION_DENIED', 403);
	const o = w.offers.find(x => x.id === offerId);
	if (!o) return blockOf('NOT_FOUND', 404);
	const rs = String(w.request?.status ?? '');
	if (rs === 'CANCELLED' || rs === 'COMPLETED') return blockOf('OFFER_REQUEST_CLOSED');
	const linked = o.status === ProposalStatus.ACCEPTED || o.status === ProposalStatus.PENDING_SIGNATURE || (!!w.contract && w.contract.providerId === o.providerId && !CLOSED_CONTRACT.includes(w.contract.status) && o.status !== ProposalStatus.REJECTED && o.status !== ProposalStatus.CANCELLED);
	if (action === 'OFFER_SUSPEND') {
		if (o.adminSuspendedAt) return blockOf('OFFER_ALREADY_SUSPENDED');
		if (linked) return blockOf('OFFER_LINKED_TO_CONTRACT');
		if (!LIVE_OFFER.includes(o.status)) return blockOf('OFFER_STATE_NOT_SUSPENDABLE');
		return null;
	}
	if (!o.adminSuspendedAt) return blockOf('OFFER_NOT_SUSPENDED');
	if (!LIVE_OFFER.includes(o.status)) return blockOf('OFFER_STATE_NOT_SUSPENDABLE');
	return null;
}

/** `viaRequest`: the request cancellation delegates its contract part here (the contract permission and the money rules apply the same). */
export function evalContract(action: 'CONTRACT_FREEZE' | 'CONTRACT_UNFREEZE' | 'CONTRACT_CANCEL' | 'ESCROW_REFUND' | 'ESCROW_RELEASE', w: World, actor: ActorView, viaRequest = false): Block | null {
	const c = w.contract;
	const financial = action === 'ESCROW_REFUND' || action === 'ESCROW_RELEASE';
	if (financial && !actor.isSuperAdmin) return blockOf('SUPER_ADMIN_REQUIRED', 403);
	if (!actor.has('contracts.manage')) return blockOf('PERMISSION_DENIED', 403);
	if (!c) return blockOf('NO_CONTRACT', 409);
	const closed = CLOSED_CONTRACT.includes(c.status);
	if (action === 'CONTRACT_FREEZE') {
		if (closed) return blockOf('CONTRACT_CLOSED');
		if (c.adminFrozenAt) return blockOf('CONTRACT_ALREADY_FROZEN');
		return null;
	}
	if (action === 'CONTRACT_UNFREEZE') {
		if (!c.adminFrozenAt) return blockOf('CONTRACT_NOT_FROZEN');
		return null;
	}
	// cancel / refund / release
	if (closed) return blockOf('CONTRACT_CLOSED');
	if (w.activeDisputes > 0 || c.status === ContractStatus.DISPUTED) return blockOf('ACTIVE_DISPUTE');
	if (w.agreedCancellation) return blockOf('CANCELLATION_AGREED_PENDING_SETTLEMENT');
	if (action === 'CONTRACT_CANCEL') {
		// A cancellation that would have to decide what happens to HELD money needs a settlement rule that the product has NOT approved: it is refused here (the explicit refund / release actions are the separate, previewed money decisions).
		if (w.escrow && w.held > 0 && w.escrow.status === EscrowStatus.HELD) return blockOf('CANCELLATION_SETTLEMENT_NOT_APPROVED');
		return null;
	}
	if (!w.escrow) return blockOf('NO_ESCROW');
	if (w.escrow.status === EscrowStatus.RELEASED) return blockOf('ESCROW_ALREADY_RELEASED');
	if (w.escrow.status === EscrowStatus.REFUNDED) return blockOf('ESCROW_ALREADY_REFUNDED');
	if (w.held <= 0) return blockOf('NO_HELD_BALANCE');
	if (c.adminFrozenAt) return blockOf('CONTRACT_FROZEN');
	if (action === 'ESCROW_RELEASE' && c.status !== ContractStatus.ACTIVE) return blockOf('RELEASE_REQUIRES_ACTIVE_CONTRACT');
	return null;
}

// ───────────────────────── idempotent runner ─────────────────────────
interface RunCtx { adminId: string; key: string; action: AdminControlAction; entityType: 'REQUEST' | 'OFFER' | 'CONTRACT'; entityId: string; payload: Record<string, unknown> }
type AfterCommit = () => Promise<void>;

async function runGuarded<T extends Record<string, unknown>>(ctx: RunCtx, body: (tx: Tx) => Promise<{ result: T; after: AfterCommit }>): Promise<T & { replayed: boolean }> {
	const requestHash = sha({ action: ctx.action, entityType: ctx.entityType, entityId: ctx.entityId, payload: ctx.payload });
	const replay = async () => {
		const prior = await prisma.adminActionIdempotency.findUnique({ where: { adminId_key: { adminId: ctx.adminId, key: ctx.key } } });
		if (!prior) return null;
		if (prior.requestHash !== requestHash) throw fail('IDEMPOTENCY_KEY_CONFLICT', 409);
		return { ...(prior.response as Record<string, unknown>), replayed: true } as T & { replayed: boolean };
	};
	const hit = await replay();
	if (hit) return hit;
	let done: { result: T; after: AfterCommit };
	try {
		done = await prisma.$transaction(async tx => {
			// the key row goes in FIRST: a parallel request with the same key waits on the unique index and, once this commits, replays (or, if this rolls back, runs itself)
			await tx.adminActionIdempotency.create({ data: { adminId: ctx.adminId, key: ctx.key, action: ctx.action, entityType: ctx.entityType, entityId: ctx.entityId, requestHash, response: {} } });
			const out = await body(tx);
			await tx.adminActionIdempotency.update({ where: { adminId_key: { adminId: ctx.adminId, key: ctx.key } }, data: { response: out.result as Prisma.InputJsonObject } });
			return out;
		}, TX_OPTIONS);
	} catch (e: any) {
		if (e?.code === 'P2002') {
			const again = await replay();
			if (again) return again;
			// a unique reference of the money rows (wallet refund reference): the same money was already moved
			throw fail('ESCROW_CHANGED', 409);
		}
		throw e;
	}
	try { await done.after(); } catch (e) { logger.error(`[admin-order-controls] after-commit step failed for ${ctx.action} ${ctx.entityId}: ${(e as Error)?.message}`); }
	return { ...done.result, replayed: false };
}

async function notifyEach(inputs: Array<CreateNotificationInput | null>) {
	for (const n of inputs) {
		if (!n) continue;
		try { await adminControlDeps.notify(n); } catch (e) { logger.error(`[admin-order-controls] notification failed: ${(e as Error)?.message}`); }
	}
}

const PARTY_NOTE = 'بقرار من إدارة المنصة.';
const clientIdOf = (w: World): string | null => w.request?.clientProfile?.userId ?? w.contract?.clientId ?? w.project?.clientId ?? null;
const usd = (n: number) => `${round2(n)} $`;

// ───────────────────────── the service ─────────────────────────
export class AdminOrderControlsService {
	// ---------- read models ----------
	async requestControls(requestId: string, actor: AdminActor) {
		const w = await loadWorld(prisma, requestId);
		if (!w.request) throw fail('NOT_FOUND', 404);
		const v = viewOf(actor);
		const cancel = await this.cancelImpact(w);
		return {
			requestId, version: requestVersion(w), status: w.request.status, suspended: !!w.request.adminSuspendedAt, suspendedAt: w.request.adminSuspendedAt, suspendReason: w.request.adminSuspendReason ?? null,
			cancelledAt: w.request.adminCancelledAt, cancelReason: w.request.adminCancelReason ?? null,
			contract: w.contract ? { id: w.contract.id, status: w.contract.status, frozen: !!w.contract.adminFrozenAt } : null,
			actions: {
				REQUEST_SUSPEND: this.describe(evalRequest('REQUEST_SUSPEND', w, v)),
				REQUEST_RESUME: this.describe(evalRequest('REQUEST_RESUME', w, v)),
				REQUEST_CANCEL: this.describe(evalRequest('REQUEST_CANCEL', w, v)),
			},
			cancelImpact: cancel
		};
	}

	async offerControls(offerId: string, actor: AdminActor) {
		const o = await prisma.projectProposal.findUnique({ where: { id: offerId }, select: { projectId: true } });
		if (!o) throw fail('NOT_FOUND', 404);
		const w = await loadWorld(prisma, o.projectId);
		const offer = w.offers.find(x => x.id === offerId)!;
		const v = viewOf(actor);
		return {
			offerId, requestId: o.projectId, version: offerVersion(w, offerId), status: offer.status, suspended: !!offer.adminSuspendedAt, suspendedAt: offer.adminSuspendedAt, suspendReason: offer.adminSuspendReason ?? null,
			contract: w.contract && w.contract.providerId === offer.providerId ? { id: w.contract.id, status: w.contract.status } : null,
			actions: { OFFER_SUSPEND: this.describe(evalOffer('OFFER_SUSPEND', w, offerId, v)), OFFER_RESUME: this.describe(evalOffer('OFFER_RESUME', w, offerId, v)) }
		};
	}

	/** Controls of a contract by the CONTRACT id or the PROJECT id (the project page and the contract page share them). */
	async contractControls(key: string, actor: AdminActor) {
		const c = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }] }, select: { id: true, projectId: true } });
		if (!c) {
			const p = await prisma.project.findUnique({ where: { id: key }, select: { id: true } });
			if (!p) throw fail('NOT_FOUND', 404);
			const w0 = await loadWorld(prisma, key);
			const none = this.describe(blockOf('NO_CONTRACT'));
			return { contractId: null, projectId: key, version: requestVersion(w0), status: null, frozen: false, escrow: null, actions: { CONTRACT_FREEZE: none, CONTRACT_UNFREEZE: none, CONTRACT_CANCEL: none, ESCROW_REFUND: none, ESCROW_RELEASE: none } };
		}
		const w = await loadWorld(prisma, c.projectId);
		const v = viewOf(actor);
		return {
			contractId: c.id, projectId: c.projectId, version: contractVersion(w), status: w.contract.status, frozen: !!w.contract.adminFrozenAt, frozenAt: w.contract.adminFrozenAt, freezeReason: w.contract.adminFreezeReason ?? null,
			escrow: w.escrow ? { status: w.escrow.status, amount: w.escrow.amount, releasedAmount: w.escrow.releasedAmount, heldAmount: w.held } : null,
			activeDisputes: w.activeDisputes, cancellationAgreed: w.agreedCancellation,
			actions: {
				CONTRACT_FREEZE: this.describe(evalContract('CONTRACT_FREEZE', w, v)),
				CONTRACT_UNFREEZE: this.describe(evalContract('CONTRACT_UNFREEZE', w, v)),
				CONTRACT_CANCEL: this.describe(evalContract('CONTRACT_CANCEL', w, v)),
				ESCROW_REFUND: this.describe(evalContract('ESCROW_REFUND', w, v)),
				ESCROW_RELEASE: this.describe(evalContract('ESCROW_RELEASE', w, v)),
			}
		};
	}

	private describe(b: Block | null) { return b ? { allowed: false, code: wire(b.code as AdminControlReason), message: b.message, requiresSuperAdmin: b.code === 'SUPER_ADMIN_REQUIRED' } : { allowed: true, code: null, message: null, requiresSuperAdmin: false }; }

	/** What cancelling the request does to everything attached to it (shown before the confirmation). */
	private async cancelImpact(w: World) {
		const liveOffers = w.offers.filter(o => OPEN_OFFER_STATUSES.includes(o.status)).length;
		return {
			offersToClose: liveOffers,
			contract: w.contract ? { id: w.contract.id, status: w.contract.status } : null,
			heldAmount: w.held, escrowStatus: w.escrow?.status ?? null,
			settlementOptions: [],
			settlementBlocked: w.held > 0 && w.escrow?.status === EscrowStatus.HELD ? { code: 'CANCELLATION_SETTLEMENT_NOT_APPROVED' } : null,
			effects: this.cancelEffects(w)
		};
	}
	private cancelEffects(w: World): string[] {
		const e = ['REQUEST_CANCELLED', 'OFFERS_CLOSED', 'PARTIES_NOTIFIED'];
		if (w.contract) e.push('CONTRACT_CANCELLED', 'PROJECT_CLOSED');
		if (w.openCancellations) e.push('OPEN_CANCELLATION_REQUESTS_CLOSED');
		if (w.openAmendments) e.push('OPEN_AMENDMENTS_CANCELLED');
		if (w.contract?.adminFrozenAt) e.push('FREEZE_CLEARED');
		return e;
	}

	/** Quote of a financial / closing contract action: amounts, beneficiary, commission and the effect, BEFORE the confirmation. Moves nothing and writes nothing. */
	async quoteContract(key: string, action: 'CANCEL' | 'REFUND' | 'RELEASE', actor: AdminActor) {
		const c = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }] }, select: { id: true, projectId: true } });
		if (!c) throw fail('NOT_FOUND', 404);
		const w = await loadWorld(prisma, c.projectId);
		const act = action === 'CANCEL' ? 'CONTRACT_CANCEL' : action === 'REFUND' ? 'ESCROW_REFUND' : 'ESCROW_RELEASE';
		return this.buildQuote(w, act, evalContract(act, w, viewOf(actor)));
	}

	async quoteRequestCancel(requestId: string, actor: AdminActor) {
		const w = await loadWorld(prisma, requestId);
		if (!w.request) throw fail('NOT_FOUND', 404);
		const block = evalRequest('REQUEST_CANCEL', w, viewOf(actor));
		return { ...this.buildQuote(w, 'CONTRACT_CANCEL', block, true), effects: this.cancelEffects(w), requestId, version: requestVersion(w), requestStatus: w.request.status, offersToClose: w.offers.filter(o => OPEN_OFFER_STATUSES.includes(o.status)).length };
	}

	private buildQuote(w: World, act: 'CONTRACT_CANCEL' | 'ESCROW_REFUND' | 'ESCROW_RELEASE', block: Block | null, viaRequest = false) {
		const c = w.contract, e = w.escrow;
		const moves = !!e && e.status === EscrowStatus.HELD && w.held > 0;
		const release = act === 'ESCROW_RELEASE' && moves;
		const refund = moves && act === 'ESCROW_REFUND';
		const split = release && isV2Escrow(e) && e.providerCommissionRateSnapshot != null
			? splitRelease({ grossReleasedBefore: e.releasedAmount, commissionTotalBefore: e.platformCommissionAmount, grossReleasedAfter: e.releasedAmount + w.held, ratePercent: e.providerCommissionRateSnapshot }) : null;
		const effects: string[] = [];
		if (refund) effects.push('HELD_REFUNDED_TO_CLIENT');
		if (release) effects.push('HELD_RELEASED_TO_PROVIDER');
		if (c) effects.push(act === 'ESCROW_RELEASE' ? 'CONTRACT_COMPLETED' : 'CONTRACT_CANCELLED', 'PROJECT_CLOSED', 'REQUEST_CLOSED');
		if (w.openCancellations) effects.push('OPEN_CANCELLATION_REQUESTS_CLOSED');
		if (w.openAmendments) effects.push('OPEN_AMENDMENTS_CANCELLED');
		if (c?.adminFrozenAt) effects.push('FREEZE_CLEARED');
		effects.push('PARTIES_NOTIFIED', 'ALREADY_RELEASED_UNCHANGED');
		return {
			action: act, viaRequest, contractId: c?.id ?? null, projectId: w.projectId, version: c ? contractVersion(w) : null, currency: 'USD',
			blocked: block ? { code: wire(block.code as AdminControlReason), message: block.message } : null,
			expectedHeldAmount: w.held,
			escrow: e ? { status: e.status, amount: e.amount, releasedAmount: e.releasedAmount, heldAmount: w.held } : null,
			amounts: { heldBefore: moves ? w.held : 0, refundToClient: refund ? w.held : 0, releaseToProvider: release ? w.held : 0, platformCommission: split?.commission ?? 0, providerNet: release ? (split ? split.net : w.held) : 0 },
			beneficiary: release ? { kind: 'PROVIDER', userId: c?.providerId ?? null, name: fullName(c?.provider) } : refund ? { kind: 'CLIENT', userId: c?.clientId ?? null, name: fullName(c?.client) } : { kind: 'NONE', userId: null, name: null },
			commission: { feePolicyVersion: e?.feePolicyVersion ?? null, ratePercent: e && isV2Escrow(e) ? e.providerCommissionRateSnapshot ?? null : null, appliesTo: release ? 'RELEASE' : 'NONE' },
			settlement: w.held > 0 && act === 'CONTRACT_CANCEL' ? { options: [], blocked: { code: 'CANCELLATION_SETTLEMENT_NOT_APPROVED' } } : null,
			after: { contractStatus: c ? (act === 'ESCROW_RELEASE' ? 'COMPLETED' : 'CANCELLED') : null, projectStatus: act === 'ESCROW_RELEASE' ? 'COMPLETED' : 'CANCELLED', requestStatus: act === 'ESCROW_RELEASE' ? 'COMPLETED' : 'CANCELLED', escrowStatus: !moves || act === 'CONTRACT_CANCEL' ? (e?.status ?? null) : release ? 'RELEASED' : 'REFUNDED' },
			parties: { client: c ? { id: c.clientId, name: fullName(c.client) } : null, provider: c ? { id: c.providerId, name: fullName(c.provider) } : null },
			effects
		};
	}

	// ---------- request actions ----------
	async suspendRequest(adminId: AdminActor, requestId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) {
		return this.simpleRequestAction('REQUEST_SUSPEND', adminId, requestId, input);
	}
	async resumeRequest(actor: AdminActor, requestId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) {
		return this.simpleRequestAction('REQUEST_RESUME', actor, requestId, input);
	}

	private async simpleRequestAction(action: 'REQUEST_SUSPEND' | 'REQUEST_RESUME', actor: AdminActor, requestId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) {
		const suspend = action === 'REQUEST_SUSPEND';
		const key = cleanKey(input.key);
		const reason = cleanReason(input.reason, suspend);
		const expectedVersion = cleanVersion(input.expectedVersion);
		const v = viewOf(actor);
		return runGuarded({ adminId: actor.userId, key, action, entityType: 'REQUEST', entityId: requestId, payload: { reason, expectedVersion } }, async tx => {
			await ROW_LOCK.request(tx, requestId);
			const w = await loadWorld(tx, requestId);
			const block = evalRequest(action, w, v);
			if (block) throw fail(block.code as AdminControlReason, block.status);
			if (requestVersion(w) !== expectedVersion) throw fail('STALE_VERSION', 409, [{ currentVersion: requestVersion(w) }]);
			const now = new Date();
			const claimed = await tx.clientRequest.updateMany({
				where: { id: requestId, status: RequestStatus.OPEN, adminSuspendedAt: suspend ? null : { not: null } },
				data: suspend ? { adminSuspendedAt: now, adminSuspendedById: actor.userId, adminSuspendReason: reason } : { adminSuspendedAt: null, adminSuspendedById: null, adminSuspendReason: null }
			});
			if (claimed.count !== 1) throw fail('STALE_VERSION', 409);
			await adminAudit.recordTx(tx, {
				adminId: actor.userId, entity: 'REQUEST', entityId: requestId, eventType: suspend ? 'REQUEST_SUSPENDED' : 'REQUEST_RESUMED',
				title: suspend ? 'تعليق طلب' : 'استئناف طلب', summary: suspend ? 'تعليق طلب مؤقتًا: لا يستقبل عروضًا جديدة' : 'استئناف طلب معلّق',
				severity: 'WARNING', before: { status: w.request.status, suspended: !suspend }, after: { status: w.request.status, suspended: suspend }, details: { reason, idempotencyKey: key, offersKept: w.offers.length }
			});
			const clientId = clientIdOf(w);
			const providers = [...new Set(w.offers.filter(o => OPEN_OFFER_STATUSES.includes(o.status)).map(o => o.providerId))];
			const title = w.request.title as string;
			const result = { action, entityType: 'REQUEST', entityId: requestId, requestStatus: w.request.status as string, suspended: suspend };
			return {
				result,
				after: async () => notifyEach([
					clientId ? { userId: clientId, title: suspend ? 'تم تعليق طلبك مؤقتًا' : 'عاد طلبك للعمل', message: suspend ? `عُلّق الطلب «${title}» مؤقتًا ${PARTY_NOTE} لن يستقبل عروضًا جديدة وتبقى بياناته وعروضه الحالية كما هي.` : `استؤنف الطلب «${title}» ${PARTY_NOTE} يستقبل عروضًا جديدة من جديد.`, category: NotificationCategory.PROJECTS, type: suspend ? 'ADMIN_REQUEST_SUSPENDED' : 'ADMIN_REQUEST_RESUMED', actionUrl: CLIENT_ROUTES.request(requestId), actionText: 'عرض الطلب', metadata: { requestId } } : null,
					...providers.map(p => ({ userId: p, title: suspend ? 'عُلّق طلب قدّمت عليه عرضًا' : 'استؤنف طلب قدّمت عليه عرضًا', message: suspend ? `عُلّق الطلب «${title}» مؤقتًا ${PARTY_NOTE} عرضك محفوظ كما هو.` : `استؤنف الطلب «${title}» ${PARTY_NOTE}`, category: NotificationCategory.OFFERS, type: suspend ? 'ADMIN_REQUEST_SUSPENDED' : 'ADMIN_REQUEST_RESUMED', actionUrl: PROVIDER_ROUTES.offers, actionText: 'عرض عروضي', metadata: { requestId } }))
				])
			};
		});
	}

	async cancelRequest(actor: AdminActor, requestId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown; confirm?: unknown; expectedHeldAmount?: unknown; settlement?: unknown }) {
		const key = cleanKey(input.key);
		const reason = cleanReason(input.reason);
		const expectedVersion = cleanVersion(input.expectedVersion);
		if (input.confirm !== true) throw fail('CONFIRMATION_REQUIRED', 400, [{ field: 'confirm', path: 'confirm', message: adminControlMessage('CONFIRMATION_REQUIRED') }]);
		const v = viewOf(actor);
		const expectedHeld = cleanMoney(input.expectedHeldAmount);
		const settlement = typeof input.settlement === 'string' ? input.settlement : null;
		return runGuarded({ adminId: actor.userId, key, action: 'REQUEST_CANCEL', entityType: 'REQUEST', entityId: requestId, payload: { reason, expectedVersion, expectedHeld, settlement } }, async tx => {
			await ROW_LOCK.request(tx, requestId);
			await ROW_LOCK.contract(tx, requestId);
			await ROW_LOCK.offers(tx, requestId);
			const w = await loadWorld(tx, requestId);
			const block = evalRequest('REQUEST_CANCEL', w, v);
			if (block) throw fail(block.code as AdminControlReason, block.status);
			if (requestVersion(w) !== expectedVersion) throw fail('STALE_VERSION', 409, [{ currentVersion: requestVersion(w) }]);
			const closed = await this.closeEngagement(tx, w, { mode: 'CANCEL', adminId: actor.userId, reason, key, settlement, expectedHeld, entity: 'REQUEST', viaRequest: true });
			return { result: { action: 'REQUEST_CANCEL', entityType: 'REQUEST', entityId: requestId, requestStatus: 'CANCELLED', contractStatus: closed.contractStatus, settlement: closed.settlement, offersClosed: closed.offersClosed }, after: closed.after };
		});
	}

	// ---------- offer actions ----------
	async suspendOffer(actor: AdminActor, offerId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) { return this.offerAction('OFFER_SUSPEND', actor, offerId, input); }
	async resumeOffer(actor: AdminActor, offerId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) { return this.offerAction('OFFER_RESUME', actor, offerId, input); }

	private async offerAction(action: 'OFFER_SUSPEND' | 'OFFER_RESUME', actor: AdminActor, offerId: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) {
		const suspend = action === 'OFFER_SUSPEND';
		const key = cleanKey(input.key);
		const reason = cleanReason(input.reason, true);
		const expectedVersion = cleanVersion(input.expectedVersion);
		const v = viewOf(actor);
		const pre = await prisma.projectProposal.findUnique({ where: { id: offerId }, select: { projectId: true } });
		if (!pre) throw fail('NOT_FOUND', 404);
		const requestId = pre.projectId;
		return runGuarded({ adminId: actor.userId, key, action, entityType: 'OFFER', entityId: offerId, payload: { reason, expectedVersion } }, async tx => {
			await ROW_LOCK.request(tx, requestId);
			await ROW_LOCK.contract(tx, requestId);
			await ROW_LOCK.offers(tx, requestId);
			const w = await loadWorld(tx, requestId);
			const block = evalOffer(action, w, offerId, v);
			if (block) throw fail(block.code as AdminControlReason, block.status);
			if (offerVersion(w, offerId) !== expectedVersion) throw fail('STALE_VERSION', 409, [{ currentVersion: offerVersion(w, offerId) }]);
			const offer = w.offers.find(o => o.id === offerId)!;
			const now = new Date();
			const claimed = await tx.projectProposal.updateMany({
				where: { id: offerId, status: { in: LIVE_OFFER }, adminSuspendedAt: suspend ? null : { not: null } },
				data: suspend ? { adminSuspendedAt: now, adminSuspendedById: actor.userId, adminSuspendReason: reason } : { adminSuspendedAt: null, adminSuspendedById: null, adminSuspendReason: null }
			});
			if (claimed.count !== 1) throw fail('STALE_VERSION', 409);
			await adminAudit.recordTx(tx, {
				adminId: actor.userId, entity: 'OFFER', entityId: offerId, eventType: suspend ? 'OFFER_SUSPENDED' : 'OFFER_RESUMED',
				title: suspend ? 'تعليق عرض' : 'استئناف عرض', summary: suspend ? 'تعليق عرض: لا يمكن قبوله أثناء التعليق' : 'استئناف عرض معلّق',
				severity: 'WARNING', before: { status: offer.status, suspended: !suspend }, after: { status: offer.status, suspended: suspend }, details: { reason, idempotencyKey: key, requestId }
			});
			const title = w.request?.title as string | undefined;
			const clientId = clientIdOf(w);
			return {
				result: { action, entityType: 'OFFER', entityId: offerId, requestId, offerStatus: offer.status as string, suspended: suspend, version: offerVersion({ ...w, offers: w.offers.map(o => (o.id === offerId ? { ...o, adminSuspendedAt: suspend ? now : null, updatedAt: now } : o)) } as World, offerId) },
				after: async () => notifyEach([
					{ userId: offer.providerId, title: suspend ? 'عُلّق عرضك مؤقتًا' : 'استؤنف عرضك', message: suspend ? `عُلّق عرضك على «${title}» مؤقتًا ${PARTY_NOTE} لا يمكن للعميل قبوله حتى يُستأنف.` : `استؤنف عرضك على «${title}» ${PARTY_NOTE}`, category: NotificationCategory.OFFERS, type: suspend ? 'ADMIN_OFFER_SUSPENDED' : 'ADMIN_OFFER_RESUMED', actionUrl: PROVIDER_ROUTES.offers, actionText: 'عرض عروضي', metadata: { offerId, requestId } },
					clientId ? { userId: clientId, title: suspend ? 'عُلّق أحد العروض على طلبك' : 'استؤنف عرض على طلبك', message: suspend ? `عُلّق أحد العروض على «${title}» مؤقتًا ${PARTY_NOTE} لا يمكن اختياره حتى يُستأنف.` : `استؤنف عرض على «${title}» ${PARTY_NOTE}`, category: NotificationCategory.OFFERS, type: suspend ? 'ADMIN_OFFER_SUSPENDED' : 'ADMIN_OFFER_RESUMED', actionUrl: CLIENT_ROUTES.request(requestId), actionText: 'عرض العروض', metadata: { offerId, requestId } } : null
				])
			};
		});
	}

	// ---------- contract / escrow actions ----------
	async freezeContract(actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) { return this.freezeAction('CONTRACT_FREEZE', actor, key, input); }
	async unfreezeContract(actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) { return this.freezeAction('CONTRACT_UNFREEZE', actor, key, input); }

	private async contractRef(key: string) {
		const c = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }] }, select: { id: true, projectId: true } });
		if (!c) throw fail('NOT_FOUND', 404);
		return c;
	}

	private async freezeAction(action: 'CONTRACT_FREEZE' | 'CONTRACT_UNFREEZE', actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown }) {
		const freeze = action === 'CONTRACT_FREEZE';
		const idem = cleanKey(input.key);
		const reason = cleanReason(input.reason, freeze);
		const expectedVersion = cleanVersion(input.expectedVersion);
		const v = viewOf(actor);
		const ref = await this.contractRef(key);
		return runGuarded({ adminId: actor.userId, key: idem, action, entityType: 'CONTRACT', entityId: ref.id, payload: { reason, expectedVersion } }, async tx => {
			await ROW_LOCK.request(tx, ref.projectId);
			await ROW_LOCK.contract(tx, ref.projectId);
			const w = await loadWorld(tx, ref.projectId);
			const block = evalContract(action, w, v);
			if (block) throw fail(block.code as AdminControlReason, block.status);
			if (contractVersion(w) !== expectedVersion) throw fail('STALE_VERSION', 409, [{ currentVersion: contractVersion(w) }]);
			const now = new Date();
			const claimed = await tx.contract.updateMany({
				where: { id: ref.id, adminFrozenAt: freeze ? null : { not: null }, ...(freeze ? { status: { notIn: CLOSED_CONTRACT } } : {}) },
				data: freeze ? { adminFrozenAt: now, adminFrozenById: actor.userId, adminFreezeReason: reason } : { adminFrozenAt: null, adminFrozenById: null, adminFreezeReason: null }
			});
			if (claimed.count !== 1) throw fail('STALE_VERSION', 409);
			await adminAudit.recordTx(tx, {
				adminId: actor.userId, entity: 'CONTRACT', entityId: ref.id, eventType: freeze ? 'CONTRACT_FROZEN' : 'CONTRACT_UNFROZEN',
				title: freeze ? 'تجميد عقد' : 'فكّ تجميد عقد', summary: freeze ? 'تجميد عقد: لا حركة مالية جديدة عليه' : 'فكّ تجميد عقد دون تنفيذ أي دفعة تلقائيًا',
				severity: 'WARNING', before: { frozen: !freeze, contractStatus: w.contract.status }, after: { frozen: freeze, contractStatus: w.contract.status },
				details: { reason, idempotencyKey: key, projectId: ref.projectId, heldAmount: w.held, paymentExecuted: false }
			});
			const title = w.project?.title ?? w.request?.title ?? '';
			const msg = freeze ? `جُمّد العقد على «${title}» ${PARTY_NOTE} لا تُنفَّذ حركة مالية جديدة عليه حتى يُفكّ التجميد. ما صُرف سابقًا لا يتغيّر.` : `فُكّ تجميد العقد على «${title}» ${PARTY_NOTE} لم تُنفَّذ أي دفعة تلقائيًا.`;
			return {
				result: { action, entityType: 'CONTRACT', entityId: ref.id, projectId: ref.projectId, contractStatus: w.contract.status as string, frozen: freeze, version: contractVersion({ ...w, contract: { ...w.contract, adminFrozenAt: freeze ? now : null, updatedAt: now } } as World) },
				after: async () => notifyEach([
					{ userId: w.contract.clientId, title: freeze ? 'تم تجميد العقد' : 'فُكّ تجميد العقد', message: msg, category: NotificationCategory.FINANCIAL, type: freeze ? 'ADMIN_CONTRACT_FROZEN' : 'ADMIN_CONTRACT_UNFROZEN', actionUrl: CLIENT_ROUTES.project(ref.projectId), actionText: 'عرض المشروع', metadata: { contractId: ref.id } },
					{ userId: w.contract.providerId, title: freeze ? 'تم تجميد العقد' : 'فُكّ تجميد العقد', message: msg, category: NotificationCategory.FINANCIAL, type: freeze ? 'ADMIN_CONTRACT_FROZEN' : 'ADMIN_CONTRACT_UNFROZEN', actionUrl: PROVIDER_ROUTES.projectProgress(ref.projectId), actionText: 'عرض المشروع', metadata: { contractId: ref.id } }
				])
			};
		});
	}

	async cancelContract(actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown; confirm?: unknown; expectedHeldAmount?: unknown; settlement?: unknown }) {
		return this.moneyAction('CONTRACT_CANCEL', actor, key, input);
	}
	async refundToClient(actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown; confirm?: unknown; expectedHeldAmount?: unknown }) {
		return this.moneyAction('ESCROW_REFUND', actor, key, input);
	}
	async releaseToProvider(actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown; confirm?: unknown; expectedHeldAmount?: unknown }) {
		return this.moneyAction('ESCROW_RELEASE', actor, key, input);
	}

	private async moneyAction(action: 'CONTRACT_CANCEL' | 'ESCROW_REFUND' | 'ESCROW_RELEASE', actor: AdminActor, key: string, input: { reason?: unknown; expectedVersion?: unknown; key?: unknown; confirm?: unknown; expectedHeldAmount?: unknown; settlement?: unknown }) {
		const idem = cleanKey(input.key);
		const reason = cleanReason(input.reason);
		const expectedVersion = cleanVersion(input.expectedVersion);
		if (input.confirm !== true) throw fail('CONFIRMATION_REQUIRED', 400, [{ field: 'confirm', path: 'confirm', message: adminControlMessage('CONFIRMATION_REQUIRED') }]);
		const expectedHeld = cleanMoney(input.expectedHeldAmount);
		const settlement = typeof input.settlement === 'string' ? input.settlement : null;
		const v = viewOf(actor);
		const ref = await this.contractRef(key);
		return runGuarded({ adminId: actor.userId, key: idem, action, entityType: 'CONTRACT', entityId: ref.id, payload: { reason, expectedVersion, expectedHeld, settlement } }, async tx => {
			await ROW_LOCK.request(tx, ref.projectId);
			await ROW_LOCK.contract(tx, ref.projectId);
			await ROW_LOCK.offers(tx, ref.projectId);
			const w = await loadWorld(tx, ref.projectId);
			const block = evalContract(action, w, v);
			if (block) throw fail(block.code as AdminControlReason, block.status);
			if (contractVersion(w) !== expectedVersion) throw fail('STALE_VERSION', 409, [{ currentVersion: contractVersion(w) }]);
			const closed = await this.closeEngagement(tx, w, { mode: action === 'ESCROW_RELEASE' ? 'RELEASE' : action === 'ESCROW_REFUND' ? 'REFUND' : 'CANCEL', adminId: actor.userId, reason, key: idem, settlement, expectedHeld, entity: 'CONTRACT', viaRequest: false });
			return { result: { action, entityType: 'CONTRACT', entityId: ref.id, projectId: ref.projectId, contractStatus: closed.contractStatus, requestStatus: closed.requestStatus, settlement: closed.settlement, offersClosed: closed.offersClosed }, after: closed.after };
		});
	}

	/**
	 * The ONE place that closes an engagement (cancel / refund / release), inside the caller's transaction and under its row locks. Order: money (conditional escrow update, wallet row, unique reference)
	 * -> contract / project / request statuses -> open cancellation requests and amendments -> offers -> the audit row. Anything that throws rolls ALL of it back.
	 */
	private async closeEngagement(tx: Tx, w: World, o: { mode: 'CANCEL' | 'REFUND' | 'RELEASE'; adminId: string; reason: string | null; key: string; settlement: string | null; expectedHeld: number | null; entity: 'REQUEST' | 'CONTRACT'; viaRequest: boolean }) {
		const c = w.contract, e = w.escrow;
		const moves = !!c && !!e && e.status === EscrowStatus.HELD && w.held > 0;
		if (moves) {
			// defence in depth: the rule table already refuses it; a plain cancellation can never move held money
			if (o.mode === 'CANCEL') throw fail('CANCELLATION_SETTLEMENT_NOT_APPROVED', 409);
			if (o.expectedHeld === null) throw fail('EXPECTED_AMOUNT_REQUIRED', 400, [{ field: 'expectedHeldAmount', path: 'expectedHeldAmount', message: adminControlMessage('EXPECTED_AMOUNT_REQUIRED') }]);
			if (o.expectedHeld !== w.held) throw fail('HELD_BALANCE_CHANGED', 409, [{ heldAmount: w.held }]);
		}
		const release = o.mode === 'RELEASE';
		let money = { heldBefore: 0, refundToClient: 0, releaseToProvider: 0, platformCommission: 0, providerNet: 0 };
		if (moves && c && e) {
			const held = w.held;
			const split = release && isV2Escrow(e) && e.providerCommissionRateSnapshot != null
				? splitRelease({ grossReleasedBefore: e.releasedAmount, commissionTotalBefore: e.platformCommissionAmount, grossReleasedAfter: e.releasedAmount + held, ratePercent: e.providerCommissionRateSnapshot }) : null;
			const moved = await tx.escrow.updateMany({
				where: { id: e.id, status: EscrowStatus.HELD, releasedAmount: e.releasedAmount },
				data: release
					? { status: EscrowStatus.RELEASED, releasedAmount: split ? split.grossReleasedAfter : round2(e.releasedAmount + held), ...(split ? { platformCommissionAmount: split.commissionTotalAfter, providerNetReleasedAmount: split.netReleasedAfter } : {}) }
					: { status: EscrowStatus.REFUNDED }
			});
			if (moved.count !== 1) throw fail('ESCROW_CHANGED', 409);
			if (!release) {
				await tx.user.update({ where: { id: c.clientId }, data: { walletBalance: { increment: held } } });
				await tx.walletTransaction.create({ data: { userId: c.clientId, type: 'REFUND', amount: held, currency: 'USD', status: 'COMPLETED', paymentMethod: 'ESCROW', referenceId: `ADMIN-REFUND-${c.id}`, description: 'استرداد من الضمان بقرار إداري', metadata: { contractId: c.id, projectId: w.projectId, decidedBy: o.adminId, mode: o.mode } } });
				money = { heldBefore: held, refundToClient: held, releaseToProvider: 0, platformCommission: 0, providerNet: 0 };
			} else {
				money = { heldBefore: held, refundToClient: 0, releaseToProvider: held, platformCommission: split?.commission ?? 0, providerNet: split ? split.net : held };
			}
			await adminControlDeps.afterMoney?.(); // test seam: a failure here must leave NOTHING moved
		}
		const completed = release;
		const now = new Date();
		let contractStatus: string | null = null;
		if (c) {
			const done = await tx.contract.updateMany({ where: { id: c.id, status: { notIn: CLOSED_CONTRACT } }, data: { status: completed ? ContractStatus.COMPLETED : ContractStatus.CANCELLED, adminFrozenAt: null, adminFrozenById: null, adminFreezeReason: null } });
			if (done.count !== 1) throw fail('STALE_VERSION', 409);
			contractStatus = completed ? 'COMPLETED' : 'CANCELLED';
			if (w.openCancellations) await tx.contractCancellationRequest.updateMany({ where: { contractId: c.id, status: CancellationRequestStatus.PENDING_OTHER_PARTY }, data: { status: CancellationRequestStatus.REJECTED, respondedAt: now, responseNote: 'أُغلق العقد بقرار إداري' } });
			if (w.openAmendments) await tx.projectAmendment.updateMany({ where: { contractId: c.id, status: AmendmentStatus.PENDING_OTHER_PARTY }, data: { status: AmendmentStatus.CANCELLED } });
		}
		// the project mirror: an explicit CANCELLED state (never DISPUTED / DRAFT) for a cancelled / refunded engagement, COMPLETED for a release
		if (w.project) await tx.project.update({ where: { id: w.projectId }, data: { status: completed ? ProjectStatus.COMPLETED : ProjectStatus.CANCELLED } });
		await tx.clientRequest.updateMany({ where: { id: w.projectId }, data: completed
			? { status: RequestStatus.COMPLETED }
			: { status: RequestStatus.CANCELLED, adminCancelledAt: now, adminCancelledById: o.adminId, adminCancelReason: o.reason, adminSuspendedAt: null, adminSuspendedById: null, adminSuspendReason: null } });
		// offers: every open one is closed (REJECTED) unless it is the accepted offer of a contract that has run: that one follows the contract and is left as recorded
		const toClose = w.offers.filter(x => OPEN_OFFER_STATUSES.includes(x.status));
		if (!completed && toClose.length) {
			await tx.projectProposal.updateMany({ where: { id: { in: toClose.map(x => x.id) } }, data: { status: ProposalStatus.REJECTED, adminSuspendedAt: null, adminSuspendedById: null, adminSuspendReason: null } });
			await tx.proposal.updateMany({ where: { OR: [{ projectId: w.projectId }, { clientRequestId: w.projectId }], status: { in: OPEN_OFFER_STATUSES } }, data: { status: ProposalStatus.REJECTED } });
		}
		const eventType = o.entity === 'REQUEST' ? 'REQUEST_CANCELLED_BY_ADMIN' : o.mode === 'REFUND' ? 'ESCROW_REFUNDED_BY_ADMIN' : o.mode === 'RELEASE' ? 'ESCROW_RELEASED_BY_ADMIN' : 'CONTRACT_CANCELLED_BY_ADMIN';
		const titles: Record<string, string> = { REQUEST_CANCELLED_BY_ADMIN: 'إلغاء طلب من الإدارة', ESCROW_REFUNDED_BY_ADMIN: 'إعادة الضمان للعميل بقرار إداري', ESCROW_RELEASED_BY_ADMIN: 'صرف الضمان لمقدم الخدمة بقرار إداري', CONTRACT_CANCELLED_BY_ADMIN: 'إلغاء عقد من الإدارة' };
		await adminAudit.recordTx(tx, {
			adminId: o.adminId, entity: o.entity, entityId: o.entity === 'REQUEST' ? w.projectId : c!.id, eventType, title: titles[eventType], summary: titles[eventType],
			severity: moves ? 'CRITICAL' : 'WARNING',
			before: { requestStatus: w.request?.status, contractStatus: c?.status ?? null, escrowStatus: e?.status ?? null, heldAmount: w.held, frozen: !!c?.adminFrozenAt },
			after: { requestStatus: completed ? 'COMPLETED' : 'CANCELLED', contractStatus, escrowStatus: moves ? (release ? 'RELEASED' : 'REFUNDED') : e?.status ?? null },
			details: { reason: o.reason, idempotencyKey: o.key, projectId: w.projectId, contractId: c?.id ?? null, escrowId: e?.id ?? null, settlement: moves ? { ...money, choice: o.settlement ?? o.mode } : null, feePolicyVersion: e?.feePolicyVersion ?? null, commissionRatePercent: e?.providerCommissionRateSnapshot ?? null, offersClosed: completed ? 0 : toClose.length, openCancellationsClosed: w.openCancellations, openAmendmentsCancelled: w.openAmendments, freezeCleared: !!c?.adminFrozenAt, currency: 'USD' }
		});
		const title = (w.project?.title ?? w.request?.title ?? '') as string;
		const clientId = clientIdOf(w);
		const providerIds = [...new Set([...(c ? [c.providerId] : []), ...toClose.map(x => x.providerId)])];
		const moneyText = money.refundToClient > 0 ? ` أُعيد ${usd(money.refundToClient)} من الضمان إلى رصيد العميل.` : money.releaseToProvider > 0 ? ` صُرف ${usd(money.releaseToProvider)} من الضمان${money.platformCommission > 0 ? ` (عمولة المنصة ${usd(money.platformCommission)}، الصافي لمقدم الخدمة ${usd(money.providerNet)})` : ''}.` : '';
		const headline = completed ? `أغلقت الإدارة المشروع «${title}» بصرف المبلغ المحتجز لمقدم الخدمة.` : `ألغت الإدارة ${o.entity === 'REQUEST' ? 'الطلب' : 'العقد'} «${title}».`;
		const text = `${headline}${moneyText} ما صُرف سابقًا لا يتغيّر.`;
		const sets: CreateNotificationInput[] = [];
		if (clientId) sets.push({ userId: clientId, title: completed ? 'أُغلق مشروعك بقرار إداري' : 'أُلغي طلبك/عقدك بقرار إداري', message: text, category: c ? NotificationCategory.FINANCIAL : NotificationCategory.PROJECTS, type: 'ADMIN_ENGAGEMENT_CLOSED', actionUrl: CLIENT_ROUTES.request(w.projectId), actionText: 'عرض الطلب', metadata: { requestId: w.projectId, contractId: c?.id ?? null, refundToClient: money.refundToClient } });
		for (const p of providerIds) sets.push({ userId: p, title: completed ? 'أُغلق مشروعك بقرار إداري' : 'أُلغي طلب/عقد مرتبط بعرضك', message: text, category: c ? NotificationCategory.FINANCIAL : NotificationCategory.OFFERS, type: 'ADMIN_ENGAGEMENT_CLOSED', actionUrl: c && p === c.providerId ? PROVIDER_ROUTES.projectProgress(w.projectId) : PROVIDER_ROUTES.offers, actionText: 'عرض التفاصيل', metadata: { requestId: w.projectId, contractId: c?.id ?? null, releaseToProvider: p === c?.providerId ? money.providerNet : 0 } });
		return { contractStatus, requestStatus: completed ? 'COMPLETED' : 'CANCELLED', settlement: moves ? { ...money, choice: o.settlement ?? o.mode } : null, offersClosed: completed ? 0 : toClose.length, after: async () => notifyEach(sets) };
	}
}

export const adminOrderControlsService = new AdminOrderControlsService();
export { ADMIN_CONTROL_REASONS };
