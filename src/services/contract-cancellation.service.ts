import { AmendmentRequesterRole, CancellationRequestStatus, CancellationSettlementStatus, ContractStatus, EscrowStatus, LogCategory, LogStatus, NotificationCategory, Prisma, ProjectStatus, RequestStatus } from '@prisma/client';
import { assertNoAdminFreeze } from './admin-hold';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { hasActiveDispute } from './amendment-dispute-guard';
import { appendProjectEvent, projectMessagesUrl } from './project-conversation.service';
import { notificationService } from './notification.service';
import { notifyAdmins } from './admin-notifications.service';
import { assigneeHolds } from './admin-access.service';
import { assertProjectNotFrozen, lockProjectForFreezeCheck } from './dispute-freeze.service';
import { heldEscrowAmount } from './dispute.service';
import { isV2Escrow, splitRelease } from '../utils/escrow-commission';
import { round2 } from '../utils/money';

/**
 * «الإلغاء بالتراضي» — a SEPARATE persisted request (table contract_cancellation_requests): one party of an ACTIVE contract asks, the other party accepts or rejects.
 *
 * APPROVED POLICY (owner, 2026-11-05):
 *  1) before both agree, everything works as today (a stage approval pays that stage; what was paid stays);
 *  2) when both agree the request becomes AGREED_PENDING_SETTLEMENT: approving NEW stages / releasing their payments STOPS (423, cancellation-freeze.ts); the agreement ALONE moves no money;
 *  3) an administrator holding disputes.resolve + payouts.send sets the provider's share of the REAL remaining escrow, sees the client's refund before confirming and records the reason;
 *  4) on confirm the settlement executes AND the contract / project / request close in ONE transaction, with the same mechanics as the financial dispute decision
 *     (refund + release = held, commission on the gross release, explicit amounts, atomic, USD). A repeated or concurrent confirm settles once.
 */
export const CANCEL_MONEY_NOTE_AR = 'قبل اتفاق الطرفين تستمر المراحل كما هي: اعتماد العميل لمرحلة يصرف دفعتها لمقدم الخدمة وما صُرف سابقًا لا يتغيّر. بعد اتفاق الطرفين يتوقف اعتماد المراحل الجديدة، ولا يتحرك أي مبلغ بالاتفاق وحده؛ تحدد الإدارة نصيب مقدم الخدمة من المبلغ المتبقي في الضمان ويعود الباقي إلى العميل، ثم يُغلق العقد والمشروع.';
export const CANCEL_STATUS_LABEL_AR: Record<CancellationRequestStatus, string> = { PENDING_OTHER_PARTY: 'بانتظار موافقة الطرف الآخر', AGREED_PENDING_SETTLEMENT: 'تم الاتفاق — بانتظار التسوية', SETTLED: 'تمت التسوية وأُغلق العقد', REJECTED: 'رُفض الطلب', WITHDRAWN: 'سحبه صاحبه' };
export const CANCEL_SETTLEMENT_LABEL_AR: Record<CancellationSettlementStatus, string> = { NOT_APPLICABLE: '', PENDING_ADMIN_DECISION: 'التسوية المالية بانتظار قرار الإدارة ولم يُنقل أي مبلغ', SETTLED: 'نُفّذت التسوية المالية وأُغلق العقد والمشروع' };

const REASON_MIN = 3, REASON_MAX = 200, NOTE_MAX = 2000, KEY_MAX = 80;
type Side = 'CLIENT' | 'PROVIDER';
type Viewer = { userId: string; side: Side };
const OPEN = [CancellationRequestStatus.PENDING_OTHER_PARTY, CancellationRequestStatus.AGREED_PENDING_SETTLEMENT];
const NOT_FOUND = 'المشروع غير موجود أو لا تملك صلاحية الوصول إليه';

const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null, fb = '') => `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || fb;
const short = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n)}…` : t);
const other = (s: Side): Side => (s === 'CLIENT' ? 'PROVIDER' : 'CLIENT');

const INCLUDE = { contract: { select: { id: true, status: true, price: true, project: { select: { title: true } }, client: { select: { firstName: true, lastName: true } }, provider: { select: { firstName: true, lastName: true } } } } } as const;

/** Facts only (never a rule): what the contract price is and how much of the escrow is released / held right now. */
async function financialFacts(projectId: string, price: number) {
	const e = await prisma.escrow.findUnique({ where: { projectId }, select: { amount: true, releasedAmount: true, status: true } });
	if (!e) return { contractPrice: price, escrowStatus: null, escrowAmount: null, escrowReleased: null, escrowHeld: null };
	const held = Math.max(0, Math.round((e.amount - (e.releasedAmount ?? 0)) * 100) / 100);
	return { contractPrice: price, escrowStatus: e.status, escrowAmount: e.amount, escrowReleased: e.releasedAmount ?? 0, escrowHeld: held };
}

function toPublic(row: any, viewer: Viewer | 'STAFF', facts?: Record<string, unknown>) {
	const c = row.contract;
	const mySide = viewer === 'STAFF' ? null : viewer.side;
	const pending = row.status === CancellationRequestStatus.PENDING_OTHER_PARTY;
	return {
		id: row.id, contractId: row.contractId, contractRef: `CT-${String(row.contractId).slice(0, 6).toUpperCase()}`, projectId: row.projectId, projectTitle: c?.project?.title ?? null,
		contractStatus: c?.status ?? null,
		clientName: fullName(c?.client, 'العميل'), providerName: fullName(c?.provider, 'مقدم الخدمة'),
		requestedByRole: row.requestedByRole, reason: row.reason, note: row.note ?? null,
		status: row.status, statusLabel: CANCEL_STATUS_LABEL_AR[row.status as CancellationRequestStatus],
		settlementStatus: row.settlementStatus, settlementLabel: CANCEL_SETTLEMENT_LABEL_AR[row.settlementStatus as CancellationSettlementStatus] || null,
		respondedAt: row.respondedAt ?? null, responseNote: row.responseNote ?? null, withdrawnAt: row.withdrawnAt ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt,
		myRole: mySide, mine: mySide ? row.requestedByRole === mySide : null,
		canRespond: !!mySide && pending && row.requestedByRole !== mySide,
		canWithdraw: !!mySide && pending && row.requestedByRole === mySide,
		agreedAt: row.status === CancellationRequestStatus.AGREED_PENDING_SETTLEMENT || row.status === CancellationRequestStatus.SETTLED ? row.respondedAt ?? null : null,
		frozen: row.status === CancellationRequestStatus.AGREED_PENDING_SETTLEMENT,
		settledAt: row.settledAt ?? null, settlementReason: row.settlementReason ?? null,
		settlement: row.status === CancellationRequestStatus.SETTLED ? { heldBefore: row.settlementHeldBefore, refundToClient: row.settlementRefundToClient, releaseToProvider: row.settlementReleaseToProvider, platformCommission: row.settlementPlatformCommission, providerNet: row.settlementProviderNet } : null,
		moneyNote: CANCEL_MONEY_NOTE_AR, moneyMoved: row.status === CancellationRequestStatus.SETTLED,
		...(facts ? { financial: facts } : {})
	};
}

export class ContractCancellationService {
	/** The contract of this viewer (project id OR contract id) or 404-style refusal: an outsider and a missing contract look identical. */
	private async contractFor(v: Viewer, key: string) {
		const side = v.side === 'CLIENT' ? { clientId: v.userId } : { providerId: v.userId };
		const c = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }], ...side }, select: { id: true, projectId: true, clientId: true, providerId: true, status: true, price: true } });
		if (!c) throw new AppError(NOT_FOUND, 404);
		return c;
	}

	/** Requests of one contract, newest first, visible to the contract's two parties only. */
	async listForContract(v: Viewer, key: string) {
		const c = await this.contractFor(v, key);
		const rows = await prisma.contractCancellationRequest.findMany({ where: { contractId: c.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: INCLUDE });
		const facts = await financialFacts(c.projectId, c.price);
		return { requests: rows.map(r => toPublic(r, v)), eligibility: await this.eligibility(c), financial: facts, moneyNote: CANCEL_MONEY_NOTE_AR };
	}

	private async eligibility(c: { projectId: string; status: ContractStatus }): Promise<{ canRequest: boolean; reason: string | null }> {
		if (c.status !== ContractStatus.ACTIVE) return { canRequest: false, reason: c.status === ContractStatus.DISPUTED ? 'العقد في نزاع مفتوح؛ تتولى الإدارة الفصل فيه' : 'الإلغاء بالتراضي متاح للعقود النشطة فقط' };
		if (await hasActiveDispute(c.projectId)) return { canRequest: false, reason: 'يوجد نزاع مفتوح على هذا المشروع؛ لا يمكن طلب الإلغاء بالتراضي أثناءه' };
		return { canRequest: true, reason: null };
	}

	async create(v: Viewer, key: string, input: { reason?: unknown; note?: unknown; requestKey?: unknown }) {
		const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
		if (reason.length < REASON_MIN) throw new AppError('اكتب سبب الإلغاء', 400, [{ field: 'reason', path: 'reason', message: 'اكتب سبب الإلغاء' }]);
		if (reason.length > REASON_MAX) throw new AppError(`سبب الإلغاء طويل (الحد الأقصى ${REASON_MAX} حرفًا)`, 400, [{ field: 'reason', path: 'reason', message: `الحد الأقصى ${REASON_MAX} حرفًا` }]);
		const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
		if (note && note.length > NOTE_MAX) throw new AppError(`الملاحظة طويلة (الحد الأقصى ${NOTE_MAX} حرفًا)`, 400, [{ field: 'note', path: 'note', message: `الحد الأقصى ${NOTE_MAX} حرفًا` }]);
		const requestKey = typeof input.requestKey === 'string' && input.requestKey.trim() ? input.requestKey.trim().slice(0, KEY_MAX) : null;

		const c = await this.contractFor(v, key);
		// the same key from the same user is the same click: return what it already created
		if (requestKey) {
			const prior = await prisma.contractCancellationRequest.findUnique({ where: { requestedById_requestKey: { requestedById: v.userId, requestKey } }, include: INCLUDE });
			if (prior) return { ...toPublic(prior, v), replayed: true };
		}
		const el = await this.eligibility(c);
		if (!el.canRequest) throw new AppError(el.reason!, 409);

		let created: any;
		try {
			created = await prisma.$transaction(async tx => {
				// lock the contract row so two simultaneous requests (or a request racing a status change) are serialised
				const locked = await tx.contract.updateMany({ where: { id: c.id, status: ContractStatus.ACTIVE }, data: { updatedAt: new Date() } });
				if (locked.count !== 1) throw new AppError('الإلغاء بالتراضي متاح للعقود النشطة فقط', 409);
				const open = await tx.contractCancellationRequest.findFirst({ where: { contractId: c.id, status: { in: OPEN } }, select: { status: true } });
				if (open) throw new AppError(open.status === CancellationRequestStatus.AGREED_PENDING_SETTLEMENT ? 'اتفق الطرفان على الإلغاء بالتراضي بالفعل وهو بانتظار التسوية' : 'يوجد طلب إلغاء بالتراضي معلّق على هذا المشروع', 409);
				return tx.contractCancellationRequest.create({
					data: { contractId: c.id, projectId: c.projectId, clientId: c.clientId, providerId: c.providerId, requestedById: v.userId, requestedByRole: v.side as AmendmentRequesterRole, reason, note, requestKey },
					include: INCLUDE
				});
			});
		} catch (err: any) {
			if (err?.code === 'P2002') {
				// lost a race against the same key or against another open request
				if (requestKey) { const prior = await prisma.contractCancellationRequest.findUnique({ where: { requestedById_requestKey: { requestedById: v.userId, requestKey } }, include: INCLUDE }); if (prior) return { ...toPublic(prior, v), replayed: true }; }
				throw new AppError('يوجد طلب إلغاء بالتراضي معلّق على هذا المشروع', 409);
			}
			throw err;
		}
		await this.afterChange('requested', created, v);
		return { ...toPublic(created, v), replayed: false };
	}

	async respond(v: Viewer, id: string, decision: unknown, responseNote?: unknown) {
		if (decision !== 'accept' && decision !== 'reject') throw new AppError('قرار غير صالح', 400);
		const note = typeof responseNote === 'string' && responseNote.trim() ? responseNote.trim().slice(0, NOTE_MAX) : null;
		const partySide = v.side === 'CLIENT' ? { clientId: v.userId } : { providerId: v.userId };
		const pre = await prisma.contractCancellationRequest.findFirst({ where: { id, ...partySide }, include: INCLUDE });
		if (!pre) throw new AppError('الطلب غير موجود أو لا تملك صلاحية الوصول إليه', 404);
		if (pre.requestedByRole === v.side) throw new AppError('لا يمكنك الرد على طلب رفعته أنت؛ يمكنك سحبه فقط', 403);
		const target = decision === 'accept' ? CancellationRequestStatus.AGREED_PENDING_SETTLEMENT : CancellationRequestStatus.REJECTED;
		// replay of the SAME answer by the same person: nothing changes, nothing is sent twice
		const sameAnswer = decision === 'accept' ? (pre.status === target || pre.status === CancellationRequestStatus.SETTLED) : pre.status === target;
		if (sameAnswer && pre.respondedById === v.userId) return { ...toPublic(pre, v), replayed: true };
		if (pre.status !== CancellationRequestStatus.PENDING_OTHER_PARTY) throw new AppError('تم الرد على هذا الطلب أو سحبه مسبقًا', 409);
		const data = { status: target, respondedById: v.userId, respondedAt: new Date(), responseNote: note, settlementStatus: decision === 'accept' ? CancellationSettlementStatus.PENDING_ADMIN_DECISION : CancellationSettlementStatus.NOT_APPLICABLE };
		const claimWhere = { id, status: CancellationRequestStatus.PENDING_OTHER_PARTY, requestedByRole: other(v.side) as AmendmentRequesterRole };
		if (decision === 'accept') {
			// The agreement takes the SAME contract row lock as a stage approval / settlement / dispute: whichever commits second sees the other's committed state, so an approval
			// in flight is either paid fully before the freeze exists or refused by it, never half of each.
			await prisma.$transaction(async tx => {
				if (!(await lockProjectForFreezeCheck(tx, pre.projectId))) throw new AppError('لا يوجد عقد لهذا الطلب', 409);
				const c = await tx.contract.findUniqueOrThrow({ where: { id: pre.contractId }, select: { status: true } });
				if (c.status !== ContractStatus.ACTIVE) throw new AppError('الإلغاء بالتراضي متاح للعقود النشطة فقط', 409);
				await assertProjectNotFrozen(pre.projectId, tx);
				const res = await tx.contractCancellationRequest.updateMany({ where: claimWhere, data });
				if (res.count !== 1) throw new AppError('تم الرد على هذا الطلب أو سحبه مسبقًا', 409);
			});
		} else {
			const res = await prisma.contractCancellationRequest.updateMany({ where: claimWhere, data });
			if (res.count !== 1) throw new AppError('تم الرد على هذا الطلب أو سحبه مسبقًا', 409);
		}
		const row = await prisma.contractCancellationRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
		await this.afterChange(decision === 'accept' ? 'accepted' : 'rejected', row, v);
		return { ...toPublic(row, v), replayed: false };
	}

	async withdraw(v: Viewer, id: string) {
		const partySide = v.side === 'CLIENT' ? { clientId: v.userId } : { providerId: v.userId };
		const pre = await prisma.contractCancellationRequest.findFirst({ where: { id, ...partySide }, include: INCLUDE });
		if (!pre) throw new AppError('الطلب غير موجود أو لا تملك صلاحية الوصول إليه', 404);
		if (pre.requestedByRole !== v.side) throw new AppError('يمكن لصاحب الطلب وحده سحبه', 403);
		if (pre.status === CancellationRequestStatus.WITHDRAWN) return { ...toPublic(pre, v), replayed: true };
		const res = await prisma.contractCancellationRequest.updateMany({ where: { id, status: CancellationRequestStatus.PENDING_OTHER_PARTY, requestedById: v.userId }, data: { status: CancellationRequestStatus.WITHDRAWN, withdrawnAt: new Date() } });
		if (res.count !== 1) throw new AppError('تم الرد على هذا الطلب مسبقًا ولا يمكن سحبه', 409);
		const row = await prisma.contractCancellationRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
		await this.afterChange('withdrawn', row, v);
		return { ...toPublic(row, v), replayed: false };
	}

	// ── administration: read-only (who approves and what happens to the money is NOT decided) ──
	async listForAdmin(status?: string, page = 1, limit = 20) {
		const p = Math.max(1, page), l = Math.min(100, Math.max(1, limit));
		const where: Prisma.ContractCancellationRequestWhereInput = status && status in CancellationRequestStatus ? { status: status as CancellationRequestStatus } : {};
		const [rows, total, grouped] = await Promise.all([
			prisma.contractCancellationRequest.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (p - 1) * l, take: l, include: INCLUDE }),
			prisma.contractCancellationRequest.count({ where }),
			prisma.contractCancellationRequest.groupBy({ by: ['status'], _count: { _all: true } })
		]);
		const counts: Record<string, number> = {}; for (const g of grouped) counts[g.status] = g._count._all;
		return { items: rows.map(r => toPublic(r, 'STAFF')), counts, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
	}

	async getForAdmin(id: string, adminId?: string) {
		const row = await prisma.contractCancellationRequest.findUnique({ where: { id }, include: INCLUDE });
		if (!row) throw new AppError('الطلب غير موجود', 404);
		const facts = await financialFacts(row.projectId, row.contract.price);
		const pub: any = toPublic(row, 'STAFF', facts);
		pub.settlementPreview = await this.settlementPreview(row, adminId);
		return pub;
	}

	/** What the settlement screen shows, all from the database: stages paid / unpaid, the REAL remaining escrow, the commission rule. */
	private async settlementPreview(row: any, adminId?: string) {
		const [stages, escrow, contract] = await Promise.all([
			prisma.projectStage.findMany({ where: { contractId: row.contractId }, orderBy: { stepOrder: 'asc' }, select: { id: true, stepOrder: true, title: true, amount: true, status: true } }),
			prisma.escrow.findUnique({ where: { projectId: row.projectId } }),
			prisma.contract.findUnique({ where: { id: row.contractId }, select: { price: true, status: true } })
		]);
		const paid = stages.filter(s => s.status === 'APPROVED'), unpaid = stages.filter(s => s.status !== 'APPROVED');
		const held = round2(heldEscrowAmount(escrow, contract?.price) ?? 0);
		const activeDispute = await hasActiveDispute(row.projectId);
		const canHold = adminId ? await assigneeHolds(adminId, ['disputes.resolve', 'payouts.send']) : false;
		const open = row.status === CancellationRequestStatus.AGREED_PENDING_SETTLEMENT;
		let blockedReason: string | null = null;
		if (row.status === CancellationRequestStatus.SETTLED) blockedReason = 'نُفّذت التسوية مسبقًا';
		else if (!open) blockedReason = 'لا تُنفَّذ التسوية قبل اتفاق الطرفين';
		else if (contract?.status !== ContractStatus.ACTIVE) blockedReason = 'العقد لم يعد نشطًا';
		else if (activeDispute) blockedReason = 'يوجد نزاع مفتوح على المشروع؛ يُحسم النزاع أولًا';
		else if (!escrow || escrow.status !== EscrowStatus.HELD || held <= 0) blockedReason = 'لا يوجد مبلغ محتجز لتسويته';
		else if (!canHold) blockedReason = 'تنفيذ التسوية يتطلب صلاحيتي «حل النزاعات» و«إرسال الصرف» معًا';
		return {
			stages: stages.map(s => ({ id: s.id, stepOrder: s.stepOrder, title: s.title, amount: s.amount, status: s.status, paid: s.status === 'APPROVED' })),
			paidStagesTotal: round2(paid.reduce((a, s) => a + s.amount, 0)), unapprovedStagesTotal: round2(unpaid.reduce((a, s) => a + s.amount, 0)),
			contractPrice: contract?.price ?? null, escrowAmount: escrow?.amount ?? null, escrowReleased: escrow?.releasedAmount ?? null, heldAmount: held,
			commissionRatePercent: escrow && isV2Escrow(escrow) ? escrow.providerCommissionRateSnapshot ?? null : null,
			canSettle: blockedReason === null, blockedReason, viewerHoldsFinancialPermission: canHold
		};
	}

	/**
	 * Executes the agreed settlement and closes the contract / project / request in ONE transaction. Mechanics = the financial dispute decision (resolveFinancial):
	 * explicit amounts, refund + release = the REAL held balance, commission on the gross release (cumulative split), atomic, USD. `releaseToProvider` is the provider's
	 * GROSS share of the remainder; the refund is derived (held - release) and shown to the admin before confirming. Any failure rolls everything back and the request stays
	 * AGREED_PENDING_SETTLEMENT. A repeated confirm returns the stored result; two concurrent confirms settle once (contract row lock + conditional claim + unique refund reference).
	 */
	async settle(adminId: string, id: string, input: { releaseToProvider: unknown; expectedHeldAmount: unknown; reason: unknown }, hooks?: { afterMoney?: () => Promise<void> | void }) {
		if (!(await assigneeHolds(adminId, ['disputes.resolve', 'payouts.send']))) throw new AppError('تنفيذ التسوية يتطلب صلاحيتي «حل النزاعات» و«إرسال الصرف» معًا', 403);
		const num = (v: unknown, field: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || Math.abs(round2(v) - v) > 1e-9) throw new AppError('المبلغ يجب أن يكون رقمًا غير سالب بخانتين عشريتين كحد أقصى', 400, [{ field, path: field, message: 'مبلغ غير صالح' }]); return round2(v); };
		const release = num(input.releaseToProvider, 'releaseToProvider'); const expected = num(input.expectedHeldAmount, 'expectedHeldAmount');
		const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
		if (reason.length < 10) throw new AppError('سجّل سبب قرار التسوية (10 أحرف على الأقل)', 400, [{ field: 'reason', path: 'reason', message: 'سجّل سبب قرار التسوية (10 أحرف على الأقل)' }]);
		if (reason.length > NOTE_MAX) throw new AppError(`سبب القرار طويل (الحد الأقصى ${NOTE_MAX} حرفًا)`, 400, [{ field: 'reason', path: 'reason', message: 'سبب القرار طويل' }]);

		const pre = await prisma.contractCancellationRequest.findUnique({ where: { id }, include: INCLUDE });
		if (!pre) throw new AppError('الطلب غير موجود', 404);
		if (pre.status === CancellationRequestStatus.SETTLED) {
			if (pre.settlementReleaseToProvider === release) return { ...toPublic(pre, 'STAFF'), replayed: true };
			throw new AppError('نُفّذت تسوية هذا الطلب مسبقًا ولم يُنفَّذ أي مبلغ جديد', 409);
		}
		if (pre.status !== CancellationRequestStatus.AGREED_PENDING_SETTLEMENT) throw new AppError('لا تُنفَّذ التسوية قبل اتفاق الطرفين', 409);

		const summary = await prisma.$transaction(async tx => {
			if (!(await lockProjectForFreezeCheck(tx, pre.projectId))) throw new AppError('لا يوجد عقد وضمان لهذا الطلب', 409);
			const contract = await tx.contract.findUniqueOrThrow({ where: { id: pre.contractId }, select: { status: true, price: true, clientId: true, providerId: true } });
			if (contract.status !== ContractStatus.ACTIVE) throw new AppError('العقد لم يعد نشطًا: لا يوجد مبلغ محتجز لتسويته', 409);
			await assertProjectNotFrozen(pre.projectId, tx);
			await assertNoAdminFreeze({ contractId: pre.contractId, projectId: pre.projectId }, tx);
			const escrow = await tx.escrow.findUnique({ where: { projectId: pre.projectId } });
			const held = round2(heldEscrowAmount(escrow, contract.price) ?? 0);
			if (!escrow || escrow.status !== EscrowStatus.HELD || held <= 0) throw new AppError('لا يوجد مبلغ محتجز لتسويته', 409);
			if (expected !== held) throw new AppError('تغيّر المبلغ المحتجز منذ عرضه عليك. حدّث الصفحة وراجع المبالغ ثم أعد التأكيد', 409, [{ heldAmount: held }]);
			if (release > held) throw new AppError(`نصيب مقدم الخدمة (${release}) لا يمكن أن يتجاوز المبلغ المحتجز المتبقي (${held})`, 400, [{ heldAmount: held }, { field: 'releaseToProvider', path: 'releaseToProvider', message: 'يتجاوز المبلغ المتبقي' }]);
			const refund = round2(held - release);

			const split = release > 0 && isV2Escrow(escrow) && escrow.providerCommissionRateSnapshot != null
				? splitRelease({ grossReleasedBefore: escrow.releasedAmount, commissionTotalBefore: escrow.platformCommissionAmount, grossReleasedAfter: escrow.releasedAmount + release, ratePercent: escrow.providerCommissionRateSnapshot })
				: null;
			const moved = await tx.escrow.updateMany({
				where: { id: escrow.id, status: EscrowStatus.HELD, releasedAmount: escrow.releasedAmount },
				data: release > 0
					? { status: EscrowStatus.RELEASED, releasedAmount: split ? split.grossReleasedAfter : round2(escrow.releasedAmount + release), ...(split ? { platformCommissionAmount: split.commissionTotalAfter, providerNetReleasedAmount: split.netReleasedAfter } : {}) }
					: { status: EscrowStatus.REFUNDED }
			});
			if (moved.count !== 1) throw new AppError('تغيّر الضمان أثناء التنفيذ، لم يُنفَّذ أي مبلغ. أعد المحاولة', 409);
			if (refund > 0) {
				await tx.user.update({ where: { id: contract.clientId }, data: { walletBalance: { increment: refund } } });
				await tx.walletTransaction.create({ data: { userId: contract.clientId, type: 'REFUND', amount: refund, currency: 'USD', status: 'COMPLETED', paymentMethod: 'ESCROW', referenceId: `CANCEL-REFUND-${id}`, description: 'استرداد من الضمان بالإلغاء بالتراضي', metadata: { cancellationRequestId: id, projectId: pre.projectId, contractId: pre.contractId, decidedBy: adminId } } });
			}
			await hooks?.afterMoney?.(); // test seam: a failure here must leave NOTHING moved
			const toProvider = release > 0;
			await tx.contract.update({ where: { id: pre.contractId }, data: { status: ContractStatus.CANCELLED } });
			await tx.project.update({ where: { id: pre.projectId }, data: { status: toProvider ? ProjectStatus.COMPLETED : ProjectStatus.DISPUTED } });
			await tx.clientRequest.updateMany({ where: { proposals: { some: { projectId: pre.projectId } } }, data: { status: toProvider ? RequestStatus.COMPLETED : RequestStatus.CANCELLED } });
			const result = { heldBefore: held, refundToClient: refund, releaseToProvider: release, platformCommission: split?.commission ?? 0, providerNet: split ? split.net : release };
			const claimed = await tx.contractCancellationRequest.updateMany({ where: { id, status: CancellationRequestStatus.AGREED_PENDING_SETTLEMENT }, data: { status: CancellationRequestStatus.SETTLED, settlementStatus: CancellationSettlementStatus.SETTLED, settledAt: new Date(), settledById: adminId, settlementReason: reason, settlementHeldBefore: held, settlementRefundToClient: refund, settlementReleaseToProvider: release, settlementPlatformCommission: result.platformCommission, settlementProviderNet: result.providerNet } });
			if (claimed.count !== 1) throw new AppError('نُفّذت تسوية هذا الطلب مسبقًا ولم يُنفَّذ أي مبلغ جديد', 409);
			await tx.accountAuditLog.create({ data: {
				userId: adminId, category: LogCategory.SYSTEM_AUDIT, title: 'تسوية إلغاء بالتراضي', actionText: 'تنفيذ تسوية مالية لإلغاء بالتراضي', summary: 'تنفيذ تسوية مالية لإلغاء بالتراضي', status: LogStatus.COMPLETED,
				eventType: 'CANCELLATION_SETTLED', source: 'ADMIN', severity: 'CRITICAL',
				beforeData: { escrowStatus: escrow.status, heldAmount: held, escrowReleasedBefore: escrow.releasedAmount } as Prisma.InputJsonObject,
				afterData: { escrowStatus: release > 0 ? EscrowStatus.RELEASED : EscrowStatus.REFUNDED, contractStatus: ContractStatus.CANCELLED } as Prisma.InputJsonObject,
				context: { entity: 'CANCELLATION_REQUEST', entityId: id, projectId: pre.projectId, contractId: pre.contractId, escrowId: escrow.id, outcomeSummary: { ...result }, reason, feePolicyVersion: escrow.feePolicyVersion ?? null, commissionRatePercent: escrow.providerCommissionRateSnapshot ?? null } as Prisma.InputJsonObject
			} });
			return result;
		});

		const row = await prisma.contractCancellationRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
		await this.afterSettle(row, adminId, summary);
		return { ...toPublic(row, 'STAFF'), replayed: false };
	}

	private async afterSettle(row: any, adminId: string, s: { refundToClient: number; releaseToProvider: number; providerNet: number }) {
		const text = `نفّذت الإدارة تسوية الإلغاء بالتراضي: عاد إلى العميل ${s.refundToClient} $ ولمقدم الخدمة ${s.releaseToProvider} $ (الصافي ${s.providerNet} $) وأُغلق العقد والمشروع.`;
		try { await appendProjectEvent({ contractId: row.contractId, eventKey: `cancel:${row.id}:settled`, actorId: adminId, text, event: 'CANCELLATION_SETTLED', meta: { cancellationRequestId: row.id, cancellationStatus: row.status } }); } catch (e) { logger.error(`[Cancellation] settle event failed: ${(e as Error)?.message}`); }
		for (const [uid, side] of [[row.clientId, 'CLIENT'], [row.providerId, 'PROVIDER']] as const) {
			try { await notificationService.createAndEmit({ userId: uid, title: 'تمت تسوية الإلغاء بالتراضي', message: text, category: NotificationCategory.FINANCIAL, type: 'PROJECT_CANCELLATION', actionUrl: projectMessagesUrl(side, row.contractId), actionText: 'عرض المشروع', metadata: { contractId: row.contractId, cancellationRequestId: row.id, decision: 'settled' } }); } catch (e) { logger.error(`[Cancellation] settle notify failed: ${(e as Error)?.message}`); }
		}
	}

	/** After the state change committed: the project room gets ONE system message (deterministic key), the other party is notified, the administration is told. None of it can fail the action. */
	private async afterChange(kind: 'requested' | 'accepted' | 'rejected' | 'withdrawn', row: any, v: Viewer) {
		const who = v.side === 'CLIENT' ? 'العميل' : 'مقدم الخدمة';
		const text = {
			requested: `${who} طلب الإلغاء بالتراضي. السبب: ${short(row.reason, 120)}. بانتظار رد الطرف الآخر؛ لا يتغيّر العقد أو الضمان قبل ذلك.`,
			accepted: `وافق ${who} على الإلغاء بالتراضي — تم الاتفاق وبانتظار التسوية. توقف اعتماد المراحل الجديدة ولم يُنقل أي مبلغ؛ ما صُرف سابقًا لا يتغيّر.`,
			rejected: `رفض ${who} طلب الإلغاء بالتراضي. العقد مستمر كما هو.`,
			withdrawn: `سحب ${who} طلب الإلغاء بالتراضي. العقد مستمر كما هو.`
		}[kind];
		try { await appendProjectEvent({ contractId: row.contractId, eventKey: `cancel:${row.id}:${kind}`, actorId: v.userId, text, event: `CANCELLATION_${kind.toUpperCase()}`, meta: { cancellationRequestId: row.id, cancellationStatus: row.status } }); } catch (e) { logger.error(`[Cancellation] project event failed: ${(e as Error)?.message}`); }
		const toId = v.side === 'CLIENT' ? row.providerId : row.clientId;
		const toSide: Side = other(v.side);
		const titles = { requested: 'طلب إلغاء بالتراضي', accepted: 'تم الاتفاق على الإلغاء بالتراضي', rejected: 'رُفض طلب الإلغاء بالتراضي', withdrawn: 'سُحب طلب الإلغاء بالتراضي' } as const;
		try {
			await notificationService.createAndEmit({ userId: toId, title: titles[kind], message: `${text}`, category: NotificationCategory.PROJECTS, type: 'PROJECT_CANCELLATION', actionUrl: projectMessagesUrl(toSide, row.contractId), actionText: 'فتح المحادثة', metadata: { contractId: row.contractId, cancellationRequestId: row.id, decision: kind } });
		} catch (e) { logger.error(`[Cancellation] notify failed: ${(e as Error)?.message}`); }
		if (kind === 'requested' || kind === 'accepted') void notifyAdmins('CANCELLATION_REQUESTED', { id: row.id, ref: row.contract?.project?.title ?? null, metadata: { kind } });
	}
}

export const contractCancellationService = new ContractCancellationService();
export type CancellationViewer = Viewer;
