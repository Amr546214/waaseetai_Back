import { AmendmentRequesterRole, CancellationRequestStatus, CancellationSettlementStatus, ContractStatus, NotificationCategory, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { hasActiveDispute } from './amendment-dispute-guard';
import { appendProjectEvent, projectMessagesUrl } from './project-conversation.service';
import { notificationService } from './notification.service';
import { notifyAdmins } from './admin-notifications.service';

/**
 * «الإلغاء بالتراضي» — a SEPARATE persisted request (table contract_cancellation_requests): one party of an ACTIVE contract asks, the other party accepts or rejects.
 *
 * MONEY IS OFF. No settlement / refund rule for a mutual cancellation is approved yet (and neither is who in the administration approves it), so this service NEVER touches the
 * escrow, the wallets, the stages or the contract: an ACCEPTED request only records the agreement and waits in settlementStatus = PENDING_ADMIN_DECISION. Nothing already released
 * to approved milestones can be affected because nothing is moved at all. See docs/proposals/mutual-cancellation.md for the decisions that must be made before money moves.
 */
export const CANCEL_MONEY_NOTE_AR = 'لا يُنقل أو يُردّ أي مبلغ بمجرد الموافقة، ولا يتغيّر العقد أو الضمان أو المراحل. تسوية المبالغ في الإلغاء بالتراضي لم تُفعَّل بعد.';
export const CANCEL_STATUS_LABEL_AR: Record<CancellationRequestStatus, string> = { PENDING_OTHER_PARTY: 'بانتظار موافقة الطرف الآخر', ACCEPTED: 'وافق الطرفان على الإلغاء', REJECTED: 'رُفض الطلب', WITHDRAWN: 'سحبه صاحبه' };
export const CANCEL_SETTLEMENT_LABEL_AR: Record<CancellationSettlementStatus, string> = { NOT_APPLICABLE: '', PENDING_ADMIN_DECISION: 'التسوية المالية بانتظار قرار الإدارة ولم يُنقل أي مبلغ' };

const REASON_MIN = 3, REASON_MAX = 200, NOTE_MAX = 2000, KEY_MAX = 80;
type Side = 'CLIENT' | 'PROVIDER';
type Viewer = { userId: string; side: Side };
const OPEN = [CancellationRequestStatus.PENDING_OTHER_PARTY, CancellationRequestStatus.ACCEPTED];
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
		moneyNote: CANCEL_MONEY_NOTE_AR, moneyMoved: false,
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
				if (open) throw new AppError(open.status === CancellationRequestStatus.ACCEPTED ? 'اتفق الطرفان على الإلغاء بالتراضي بالفعل وتنتظر التسوية' : 'يوجد طلب إلغاء بالتراضي معلّق على هذا المشروع', 409);
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
		const target = decision === 'accept' ? CancellationRequestStatus.ACCEPTED : CancellationRequestStatus.REJECTED;
		// replay of the SAME answer by the same person: nothing changes, nothing is sent twice
		if (pre.status === target && pre.respondedById === v.userId) return { ...toPublic(pre, v), replayed: true };
		if (pre.status !== CancellationRequestStatus.PENDING_OTHER_PARTY) throw new AppError('تم الرد على هذا الطلب أو سحبه مسبقًا', 409);
		if (decision === 'accept') {
			const el = await this.eligibility({ projectId: pre.projectId, status: pre.contract.status });
			if (!el.canRequest) throw new AppError(el.reason!, 409);
		}
		const res = await prisma.contractCancellationRequest.updateMany({
			where: { id, status: CancellationRequestStatus.PENDING_OTHER_PARTY, requestedByRole: other(v.side) as AmendmentRequesterRole },
			data: { status: target, respondedById: v.userId, respondedAt: new Date(), responseNote: note, settlementStatus: decision === 'accept' ? CancellationSettlementStatus.PENDING_ADMIN_DECISION : CancellationSettlementStatus.NOT_APPLICABLE }
		});
		if (res.count !== 1) throw new AppError('تم الرد على هذا الطلب أو سحبه مسبقًا', 409);
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

	async getForAdmin(id: string) {
		const row = await prisma.contractCancellationRequest.findUnique({ where: { id }, include: INCLUDE });
		if (!row) throw new AppError('الطلب غير موجود', 404);
		return toPublic(row, 'STAFF', await financialFacts(row.projectId, row.contract.price));
	}

	/** After the state change committed: the project room gets ONE system message (deterministic key), the other party is notified, the administration is told. None of it can fail the action. */
	private async afterChange(kind: 'requested' | 'accepted' | 'rejected' | 'withdrawn', row: any, v: Viewer) {
		const who = v.side === 'CLIENT' ? 'العميل' : 'مقدم الخدمة';
		const text = {
			requested: `${who} طلب الإلغاء بالتراضي. السبب: ${short(row.reason, 120)}. بانتظار رد الطرف الآخر؛ لا يتغيّر العقد أو الضمان قبل ذلك.`,
			accepted: `وافق ${who} على الإلغاء بالتراضي. تم تسجيل الاتفاق ولم يُنقل أي مبلغ؛ تسوية المبالغ لم تُفعَّل بعد.`,
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
