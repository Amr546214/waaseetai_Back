import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccountType, BroadcastAudience, NotificationCategory, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { adminAudit } from './admin-audit.service';

/**
 * Super Admin broadcast: server-side drafts -> signed preview token -> confirmed, idempotent IN-PLATFORM send -> history.
 * It writes `notifications` rows only (the same rows the in-app bell reads). It deliberately imports NOTHING that mails, pushes, texts or emits on a socket.
 */
export const AUDIENCE_TYPES: Record<BroadcastAudience, AccountType[]> = {
	CLIENTS: ['CLIENT_INDIVIDUAL', 'CLIENT_COMPANY'],
	PROVIDERS: ['PROVIDER_INDIVIDUAL', 'PROVIDER_COMPANY'],
	MARKETERS: ['MARKETING_BROKER'],
};
export const BROADCAST_NOTIFICATION_TYPE = 'ADMIN_BROADCAST';
const TOKEN_TTL_MS = 30 * 60_000;
const DRAFT_LIMIT = 20;

type Tx = Prisma.TransactionClient;
/** Seam for tests (fault injection). Production never reassigns it. */
export const broadcastDeps = {
	chunkSize: 200,
	createNotifications: async (tx: Tx, rows: Prisma.NotificationCreateManyInput[]): Promise<void> => { await tx.notification.createMany({ data: rows }); },
};

export const eligibleWhere = (audience: BroadcastAudience): Prisma.UserWhereInput => ({ accountType: { in: AUDIENCE_TYPES[audience] }, status: 'ACTIVE', isBanned: false });

export async function audienceSnapshot(audience: BroadcastAudience, db: Pick<typeof prisma, 'user'> = prisma) {
	const rows = await db.user.findMany({ where: eligibleWhere(audience), select: { id: true }, orderBy: { id: 'asc' } });
	const ids = rows.map(r => r.id);
	return { ids, count: ids.length, hash: createHash('sha256').update(ids.join('\n')).digest('hex') };
}

// ---- preview token ---------------------------------------------------------------------------------------------------------------------------------
interface PreviewClaims { a: string; d: string; v: number; f: BroadcastAudience; c: number; h: string; t: string; x: number }
function secret(): string {
	const s = process.env.JWT_SECRET;
	if (!s) throw new AppError('تعذّر توقيع المعاينة الآن. لم يُرسل شيء.', 503);
	return createHmac('sha256', s).update('admin-broadcast-preview-v1').digest('hex');
}
const sign = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url');
export function issuePreviewToken(claims: Omit<PreviewClaims, 'x'>): string {
	const body = Buffer.from(JSON.stringify({ ...claims, x: Date.now() + TOKEN_TTL_MS })).toString('base64url');
	return `${body}.${sign(body)}`;
}
export const PREVIEW_STALE = 'PREVIEW_STALE';
const stale = (message = 'تغيّر المسوّدة أو الجمهور منذ المعاينة. راجع المعاينة من جديد قبل الإرسال.') => new AppError(message, 409, undefined, PREVIEW_STALE);
function readToken(token: string): PreviewClaims {
	const [body, mac] = token.split('.');
	if (!body || !mac) throw new AppError('رمز المعاينة غير صالح.', 400, undefined, 'PREVIEW_TOKEN_INVALID');
	const expected = Buffer.from(sign(body)); const got = Buffer.from(mac);
	if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new AppError('رمز المعاينة غير صالح.', 400, undefined, 'PREVIEW_TOKEN_INVALID');
	let claims: PreviewClaims;
	try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new AppError('رمز المعاينة غير صالح.', 400, undefined, 'PREVIEW_TOKEN_INVALID'); }
	if (!(claims.x > Date.now())) throw stale('انتهت صلاحية المعاينة. راجع المعاينة من جديد قبل الإرسال.');
	return claims;
}

// ---- drafts ---------------------------------------------------------------------------------------------------------------------------------------
const draftSelect = { id: true, title: true, message: true, category: true, audience: true, version: true, sentAt: true, createdAt: true, updatedAt: true } as const;
export type DraftFields = { title?: string; message?: string; category?: NotificationCategory; audience?: BroadcastAudience | null };
const draftNotFound = () => new AppError('المسودة غير موجودة.', 404);

export class DraftConflict extends Error { constructor(public readonly current: unknown) { super('DRAFT_CONFLICT'); } }

export const drafts = {
	async create(ownerId: string, fields: DraftFields) {
		const open = await prisma.broadcastDraft.count({ where: { ownerId, sentAt: null } });
		if (open >= DRAFT_LIMIT) throw new AppError('وصلت للحد الأقصى من المسودات المفتوحة. احذف مسودة قبل إنشاء أخرى.', 409, undefined, 'BROADCAST_DRAFT_LIMIT');
		return prisma.broadcastDraft.create({ data: { ownerId, title: fields.title ?? '', message: fields.message ?? '', category: fields.category ?? 'ALL', audience: fields.audience ?? null }, select: draftSelect });
	},
	async latest(ownerId: string) {
		return prisma.broadcastDraft.findFirst({ where: { ownerId, sentAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: draftSelect });
	},
	async get(ownerId: string, id: string) {
		const draft = await prisma.broadcastDraft.findFirst({ where: { id, ownerId }, select: draftSelect });
		if (!draft) throw draftNotFound();
		return draft;
	},
	async update(ownerId: string, id: string, version: number, fields: DraftFields) {
		return prisma.$transaction(async tx => {
			const res = await tx.broadcastDraft.updateMany({ where: { id, ownerId, version, sentAt: null }, data: { ...fields, version: { increment: 1 } } });
			const row = await tx.broadcastDraft.findFirst({ where: { id, ownerId }, select: draftSelect });
			if (!row) throw draftNotFound();
			if (!res.count) {
				if (row.sentAt) throw new AppError('أُرسلت هذه المسودة بالفعل ولا يمكن تعديلها.', 409, undefined, 'DRAFT_ALREADY_SENT');
				throw new DraftConflict(row);
			}
			return row;
		});
	},
	async remove(ownerId: string, id: string, version?: number) {
		const res = await prisma.broadcastDraft.deleteMany({ where: { id, ownerId, ...(version !== undefined ? { version } : {}) } });
		if (res.count) return;
		const row = await prisma.broadcastDraft.findFirst({ where: { id, ownerId }, select: draftSelect });
		if (!row) throw draftNotFound();
		throw new DraftConflict(row);
	},
};

// ---- preview ----------------------------------------------------------------------------------------------------------------------------------------
export async function previewDraft(ownerId: string, id: string) {
	const draft = await drafts.get(ownerId, id);
	if (draft.sentAt) throw new AppError('أُرسلت هذه المسودة بالفعل.', 409, undefined, 'DRAFT_ALREADY_SENT');
	if (!draft.title.trim() || !draft.message.trim()) throw new AppError('اكتب العنوان والنص قبل المعاينة.', 422, undefined, 'BROADCAST_DRAFT_INCOMPLETE');
	if (!draft.audience) throw new AppError('اختر الجمهور قبل المعاينة.', 422, undefined, 'BROADCAST_DRAFT_INCOMPLETE');
	const snap = await audienceSnapshot(draft.audience);
	const checkedAt = new Date().toISOString();
	const previewToken = issuePreviewToken({ a: ownerId, d: draft.id, v: draft.version, f: draft.audience, c: snap.count, h: snap.hash, t: checkedAt });
	return { draftId: draft.id, version: draft.version, audience: draft.audience, count: snap.count, checkedAt, canSend: snap.count > 0, previewToken };
}

// ---- send -------------------------------------------------------------------------------------------------------------------------------------------
const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
export const validIdempotencyKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k);
const digestOf = (draftId: string, token: string) => createHash('sha256').update(`${draftId}\n${token}`).digest('hex');
const lock = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM broadcasts WHERE id = ${id} FOR UPDATE`;
const errorCodeOf = (e: unknown): string => {
	const c = (e as { code?: unknown } | null)?.code;
	return typeof c === 'string' && /^[A-Z0-9_]{2,40}$/.test(c) ? c : 'DELIVERY_ERROR';
};

async function recipientCounts(ids: string[]) {
	const rows = ids.length ? await prisma.broadcastRecipient.groupBy({ by: ['broadcastId', 'status'], where: { broadcastId: { in: ids } }, _count: { _all: true } }) : [];
	const map = new Map<string, { SENT: number; FAILED: number; PENDING: number }>();
	for (const id of ids) map.set(id, { SENT: 0, FAILED: 0, PENDING: 0 });
	for (const r of rows) map.get(r.broadcastId)![r.status] = r._count._all;
	return map;
}
const listSelect = { id: true, senderId: true, senderName: true, title: true, category: true, audience: true, audienceCount: true, status: true, createdAt: true, completedAt: true } as const;
type ListRow = Prisma.BroadcastGetPayload<{ select: typeof listSelect }>;
const view = (b: ListRow, c: { SENT: number; FAILED: number; PENDING: number }) => ({
	id: b.id, sender: { id: b.senderId, name: b.senderName }, title: b.title, category: b.category, audience: b.audience, status: b.status,
	totals: { audience: b.audienceCount, sent: c.SENT, failed: c.FAILED, pending: c.PENDING }, createdAt: b.createdAt, completedAt: b.completedAt,
});

async function finalize(id: string) {
	await prisma.$transaction(async tx => {
		await lock(tx, id);
		const grouped = await tx.broadcastRecipient.groupBy({ by: ['status'], where: { broadcastId: id }, _count: { _all: true } });
		const n = (s: string) => grouped.find(g => g.status === s)?._count._all ?? 0;
		const status = n('PENDING') > 0 ? 'SENDING' : n('FAILED') === 0 ? 'COMPLETED' : n('SENT') === 0 ? 'FAILED' : 'PARTIAL';
		await tx.broadcast.update({ where: { id }, data: { status, completedAt: status === 'SENDING' ? null : new Date() } });
	});
}

/** Delivers every PENDING recipient in chunks. Each chunk is one transaction under a row lock on the broadcast, so notifications + recipient status commit together and a parallel run can never repeat a recipient. */
async function processBroadcast(id: string) {
	for (;;) {
		const batch = await prisma.broadcastRecipient.findMany({ where: { broadcastId: id, status: 'PENDING' }, orderBy: { id: 'asc' }, take: broadcastDeps.chunkSize, select: { id: true } });
		if (!batch.length) break;
		const deliver = (ids: string[]) => prisma.$transaction(async tx => {
			await lock(tx, id);
			const b = await tx.broadcast.findUniqueOrThrow({ where: { id }, select: { title: true, message: true, category: true } });
			const rows = await tx.broadcastRecipient.findMany({ where: { id: { in: ids }, status: 'PENDING' }, select: { id: true, userId: true } });
			if (!rows.length) return;
			await broadcastDeps.createNotifications(tx, rows.map(r => ({
				id: randomUUID(), userId: r.userId, title: b.title, message: b.message, type: BROADCAST_NOTIFICATION_TYPE, category: b.category, metadata: { broadcastId: id },
			})));
			await tx.broadcastRecipient.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { status: 'SENT', errorCode: null, attempts: { increment: 1 }, updatedAt: new Date() } });
		}, { timeout: 60_000 });
		try { await deliver(batch.map(r => r.id)); } catch {
			for (const r of batch) {
				try { await deliver([r.id]); } catch (e) {
					const errorCode = errorCodeOf(e);
					await prisma.$transaction(async tx => {
						await lock(tx, id);
						await tx.broadcastRecipient.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'FAILED', errorCode, attempts: { increment: 1 }, updatedAt: new Date() } });
					});
				}
			}
		}
	}
	await finalize(id);
}

async function summary(id: string) {
	const b = await prisma.broadcast.findUniqueOrThrow({ where: { id }, select: listSelect });
	return view(b, (await recipientCounts([id])).get(id)!);
}

export async function sendBroadcast(input: { adminId: string; draftId: string; idempotencyKey: string; previewToken: string }) {
	const { adminId, draftId, idempotencyKey, previewToken } = input;
	const digest = digestOf(draftId, previewToken);
	const replay = async () => {
		const existing = await prisma.broadcast.findUnique({ where: { senderId_idempotencyKey: { senderId: adminId, idempotencyKey } }, select: { id: true, requestDigest: true } });
		if (!existing) return null;
		if (existing.requestDigest !== digest) throw new AppError('مفتاح الإرسال استُخدم مع طلب مختلف. أعد المعاينة والتأكيد.', 422, undefined, 'IDEMPOTENCY_KEY_REUSED');
		return { broadcast: await summary(existing.id), replayed: true };
	};
	const prior = await replay();
	if (prior) return prior;

	const draft = await drafts.get(adminId, draftId); // owner-only first: someone else's draft is a 404 whatever the token says
	const claims = readToken(previewToken);
	if (claims.a !== adminId || claims.d !== draftId) throw new AppError('رمز المعاينة لا يخص هذه المسودة.', 400, undefined, 'PREVIEW_TOKEN_INVALID');
	if (draft.sentAt) throw new AppError('أُرسلت هذه المسودة بالفعل.', 409, undefined, 'DRAFT_ALREADY_SENT');
	if (draft.version !== claims.v || draft.audience !== claims.f) throw stale();
	if (!draft.title.trim() || !draft.message.trim() || !draft.audience) throw stale();
	const snap = await audienceSnapshot(draft.audience);
	if (snap.count !== claims.c || snap.hash !== claims.h) throw stale('تغيّر الجمهور منذ المعاينة. راجع المعاينة من جديد قبل الإرسال.');
	if (snap.count === 0) throw new AppError('لا يوجد مستلمون مؤهلون في هذا الجمهور. لم يُرسل شيء.', 422, undefined, 'AUDIENCE_EMPTY');
	const sender = await prisma.user.findUnique({ where: { id: adminId }, select: { firstName: true, lastName: true } });
	const senderName = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ').slice(0, 160) || 'مدير النظام';

	let broadcastId: string;
	try {
		broadcastId = await prisma.$transaction(async tx => {
			const frozen = await tx.broadcastDraft.updateMany({ where: { id: draftId, ownerId: adminId, version: draft.version, sentAt: null }, data: { sentAt: new Date() } });
			if (!frozen.count) throw new AppError('أُرسلت هذه المسودة أو تغيّرت للتو.', 409, undefined, 'DRAFT_ALREADY_SENT');
			const b = await tx.broadcast.create({ data: {
				draftId, senderId: adminId, senderName, title: draft.title, message: draft.message, category: draft.category, audience: draft.audience!,
				audienceCount: snap.count, audienceHash: snap.hash, previewCheckedAt: new Date(claims.t), idempotencyKey, requestDigest: digest,
			}, select: { id: true } });
			for (let i = 0; i < snap.ids.length; i += 1000) await tx.broadcastRecipient.createMany({ data: snap.ids.slice(i, i + 1000).map(userId => ({ id: randomUUID(), broadcastId: b.id, userId })) });
			return b.id;
		}, { timeout: 60_000 });
	} catch (e) {
		// A parallel request with the same key won the race: answer with ITS broadcast instead of failing.
		const raced = await replay();
		if (raced) return raced;
		throw e;
	}
	await processBroadcast(broadcastId);
	const result = await summary(broadcastId);
	await adminAudit.record({ adminId, entity: 'BROADCAST', entityId: broadcastId, eventType: 'BROADCAST_SENT', title: 'إرسال إشعار جماعي داخل المنصة', summary: 'أرسل مدير النظام إشعارًا جماعيًا داخل المنصة.', severity: 'WARNING',
		details: { audience: draft.audience, category: draft.category, audienceCount: snap.count, sent: result.totals.sent, failed: result.totals.failed, status: result.status } });
	return { broadcast: result, replayed: false };
}

export async function retryRemaining(adminId: string, id: string) {
	const found = await prisma.broadcast.findUnique({ where: { id }, select: { id: true } });
	if (!found) throw new AppError('الإشعار الجماعي غير موجود.', 404);
	await prisma.$transaction(async tx => {
		await lock(tx, id);
		const b = await tx.broadcast.findUniqueOrThrow({ where: { id }, select: { status: true } });
		if (b.status === 'COMPLETED') throw new AppError('اكتمل الإرسال لكل المستلمين. لا يوجد ما يُعاد.', 409, undefined, 'BROADCAST_NOTHING_TO_RETRY');
		await tx.broadcastRecipient.updateMany({ where: { broadcastId: id, status: 'FAILED' }, data: { status: 'PENDING' } });
		await tx.broadcast.update({ where: { id }, data: { status: 'SENDING', completedAt: null } });
	});
	await processBroadcast(id);
	const result = await summary(id);
	await adminAudit.record({ adminId, entity: 'BROADCAST', entityId: id, eventType: 'BROADCAST_RETRIED', title: 'إعادة إرسال المتبقي من إشعار جماعي', summary: 'أعاد مدير النظام إرسال المستلمين المتبقين من إشعار جماعي.', severity: 'WARNING',
		details: { sent: result.totals.sent, failed: result.totals.failed, status: result.status } });
	return result;
}

// ---- history ----------------------------------------------------------------------------------------------------------------------------------------
const PAGE = 20;
export async function listHistory(page: number) {
	const rows = await prisma.broadcast.findMany({ select: listSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * PAGE, take: PAGE + 1 });
	const items = rows.slice(0, PAGE);
	const counts = await recipientCounts(items.map(i => i.id));
	return { page, items: items.map(b => view(b, counts.get(b.id)!)), hasNext: rows.length > PAGE };
}
export async function historyDetail(id: string) {
	const b = await prisma.broadcast.findUnique({ where: { id }, select: { ...listSelect, message: true } });
	if (!b) throw new AppError('الإشعار الجماعي غير موجود.', 404);
	const counts = (await recipientCounts([id])).get(id)!;
	const failures = await prisma.broadcastRecipient.groupBy({ by: ['errorCode'], where: { broadcastId: id, status: 'FAILED' }, _count: { _all: true } });
	return { ...view(b, counts), message: b.message, failureCodes: failures.map(f => ({ code: f.errorCode ?? 'DELIVERY_ERROR', count: f._count._all })) };
}
