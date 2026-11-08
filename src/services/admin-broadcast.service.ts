import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccountType, BroadcastAudience, NotificationCategory, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
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
	/** QUEUED/SENDING with progress and no heartbeat for this long = stopped mid-run */
	stuckMidRunMs: 10 * 60_000,
	/** QUEUED this long with the worker ON and no progress = stuck without progress */
	stuckNoProgressMs: 60 * 60_000,
	leaseMs: 60_000,
	/** test seam: runs after each committed chunk; WorkerCrash simulates a death holding the lease */
	afterChunk: undefined as undefined | ((broadcastId: string) => void | Promise<void>),
	createNotifications: async (tx: Tx, rows: Prisma.NotificationCreateManyInput[]): Promise<void> => { await tx.notification.createMany({ data: rows }); },
};

export const DEFAULT_MAX_QUEUE_AGE_HOURS = 24;
/** BROADCAST_MAX_QUEUE_AGE_HOURS: a finite number > 0 (max one year); anything else (unset, 0, negative, text) falls back to 24 h. Read on every call. */
export function parseMaxQueueAgeHours(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_QUEUE_AGE_HOURS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 && n <= 24 * 365 ? n : DEFAULT_MAX_QUEUE_AGE_HOURS;
}
export const maxQueueAgeMs = (): number => parseMaxQueueAgeHours(process.env.BROADCAST_MAX_QUEUE_AGE_HOURS) * 3_600_000;

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
	return { draftId: draft.id, version: draft.version, audience: draft.audience, count: snap.count, checkedAt, canSend: snap.count > 0, deliveryEnabled: isBroadcastWorkerEnabled(), previewToken };
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
	const map = new Map<string, { SENT: number; FAILED: number; PENDING: number; CANCELLED: number }>();
	for (const id of ids) map.set(id, { SENT: 0, FAILED: 0, PENDING: 0, CANCELLED: 0 });
	for (const r of rows) map.get(r.broadcastId)![r.status] = r._count._all;
	return map;
}
const listSelect = { id: true, senderId: true, senderName: true, title: true, category: true, audience: true, audienceCount: true, status: true, createdAt: true, completedAt: true, heartbeatAt: true } as const;
type ListRow = Prisma.BroadcastGetPayload<{ select: typeof listSelect }>;
const view = (b: ListRow, c: { SENT: number; FAILED: number; PENDING: number; CANCELLED: number }) => ({
	id: b.id, sender: { id: b.senderId, name: b.senderName }, title: b.title, category: b.category, audience: b.audience, status: b.status,
	totals: { audience: b.audienceCount, sent: c.SENT, failed: c.FAILED, pending: c.PENDING, cancelled: c.CANCELLED }, createdAt: b.createdAt, completedAt: b.completedAt, lastProgressAt: b.heartbeatAt,
});

/** Thrown by the test seam to simulate a worker that dies mid-job (holding its lease). Never caught by the worker loop. */
export class WorkerCrash extends Error {}

async function ownsLease(tx: Tx, id: string, owner: string): Promise<boolean> {
	const rows = await tx.$queryRaw<{ leaseOwner: string | null; status: string }[]>`SELECT "leaseOwner", "status" FROM broadcasts WHERE id = ${id} FOR UPDATE`;
	return rows.length === 1 && rows[0].leaseOwner === owner && (rows[0].status === 'SENDING');
}

async function finish(id: string, owner: string) {
	await prisma.$transaction(async tx => {
		if (!(await ownsLease(tx, id, owner))) return;
		const grouped = await tx.broadcastRecipient.groupBy({ by: ['status'], where: { broadcastId: id }, _count: { _all: true } });
		const n = (s: string) => grouped.find(g => g.status === s)?._count._all ?? 0;
		if (n('PENDING') > 0) return;
		const status = n('FAILED') === 0 ? 'COMPLETED' : n('SENT') === 0 ? 'FAILED' : 'PARTIAL';
		await tx.broadcast.update({ where: { id }, data: { status, completedAt: new Date(), leaseOwner: null, leaseUntil: null, heartbeatAt: new Date() } });
	});
}

/**
 * Delivers the PENDING recipients of a broadcast THIS worker has leased, in chunks. Each chunk is one transaction under a row lock that first re-checks the lease owner,
 * so notifications + recipient status + lease renewal commit together and a worker that lost its lease (expired, taken over) stops without delivering anything.
 */
async function processBroadcast(id: string, owner: string): Promise<'done' | 'lost'> {
	for (;;) {
		const batch = await prisma.broadcastRecipient.findMany({ where: { broadcastId: id, status: 'PENDING' }, orderBy: { id: 'asc' }, take: broadcastDeps.chunkSize, select: { id: true } });
		if (!batch.length) break;
		const renew = (tx: Tx) => tx.broadcast.update({ where: { id }, data: { leaseUntil: new Date(Date.now() + broadcastDeps.leaseMs), heartbeatAt: new Date() } });
		const deliver = (ids: string[]) => prisma.$transaction(async tx => {
			if (!(await ownsLease(tx, id, owner))) return 'lost' as const;
			const b = await tx.broadcast.findUniqueOrThrow({ where: { id }, select: { title: true, message: true, category: true } });
			const rows = await tx.broadcastRecipient.findMany({ where: { id: { in: ids }, status: 'PENDING' }, select: { id: true, userId: true } });
			if (rows.length) {
				await broadcastDeps.createNotifications(tx, rows.map(r => ({
					id: randomUUID(), userId: r.userId, title: b.title, message: b.message, type: BROADCAST_NOTIFICATION_TYPE, category: b.category, metadata: { broadcastId: id },
				})));
				await tx.broadcastRecipient.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { status: 'SENT', errorCode: null, attempts: { increment: 1 }, updatedAt: new Date() } });
			}
			await renew(tx);
			return 'ok' as const;
		}, { timeout: 60_000 });
		let outcome: 'ok' | 'lost' | 'failed' = 'failed';
		try { outcome = await deliver(batch.map(r => r.id)); } catch (e) { if (e instanceof WorkerCrash) throw e; }
		if (outcome === 'lost') return 'lost';
		if (outcome === 'failed') {
			for (const r of batch) {
				try { if ((await deliver([r.id])) === 'lost') return 'lost'; } catch (e) {
					if (e instanceof WorkerCrash) throw e;
					const errorCode = errorCodeOf(e);
					const lost = await prisma.$transaction(async tx => {
						if (!(await ownsLease(tx, id, owner))) return true;
						await tx.broadcastRecipient.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'FAILED', errorCode, attempts: { increment: 1 }, updatedAt: new Date() } });
						await renew(tx);
						return false;
					});
					if (lost) return 'lost';
				}
			}
		}
		await broadcastDeps.afterChunk?.(id);
	}
	await finish(id, owner);
	return 'done';
}

/** Leases one QUEUED/SENDING broadcast whose lease is free or expired. SKIP LOCKED: two workers never claim the same row. */
export async function claimBroadcast(owner: string): Promise<string | null> {
	return prisma.$transaction(async tx => {
		const now = new Date();
		const cutoff = new Date(now.getTime() - maxQueueAgeMs());
		const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM broadcasts WHERE "status" IN ('QUEUED', 'SENDING') AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now}) AND ("approvedAt" IS NOT NULL OR "createdAt" > ${cutoff}) ORDER BY "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`;
		if (!rows.length) return null;
		await tx.broadcast.update({ where: { id: rows[0].id }, data: { status: 'SENDING', leaseOwner: owner, leaseUntil: new Date(now.getTime() + broadcastDeps.leaseMs), heartbeatAt: now } });
		return rows[0].id;
	});
}

/** One pass: claim and deliver jobs until none is free. Returns the ids this worker finished or stopped on. */
let lastSkippedLogged = 0;
async function logSkippedExpired() {
	const cutoff = new Date(Date.now() - maxQueueAgeMs());
	const n = await prisma.broadcast.count({ where: { status: { in: ['QUEUED', 'SENDING'] }, approvedAt: null, createdAt: { lte: cutoff } } });
	if (n > 0 && n !== lastSkippedLogged) logger.warn(`[admin-broadcast] worker skipped ${n} expired job(s) older than ${Math.round(maxQueueAgeMs() / 3_600_000)}h awaiting admin approval`);
	lastSkippedLogged = n;
}
export async function runBroadcastWorkerOnce(owner: string): Promise<string[]> {
	const handled: string[] = [];
	await logSkippedExpired();
	for (;;) {
		const id = await claimBroadcast(owner);
		if (!id) return handled;
		handled.push(id);
		await processBroadcast(id, owner);
	}
}

/** Background worker. Disabled unless ADMIN_BROADCAST_WORKER_ENABLED=true (see startBroadcastWorkerFromEnv). Resumes unfinished jobs on start and then every `intervalMs`. */
export function startBroadcastWorker(opts: { intervalMs?: number; owner?: string } = {}) {
	const owner = opts.owner ?? `w-${randomUUID().slice(0, 12)}`;
	let running = false; let stopped = false;
	const tick = async () => {
		if (running || stopped) return;
		running = true;
		try { await runBroadcastWorkerOnce(owner); } catch (e) { logger.error(`[admin-broadcast] worker pass failed: ${(e as Error)?.message}`); } finally { running = false; }
	};
	const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? 5000);
	timer.unref?.();
	void tick();
	return { owner, tick, stop: () => { stopped = true; clearInterval(timer); } };
}
export const BROADCAST_WORKER_FLAG = 'ADMIN_BROADCAST_WORKER_ENABLED';
/** Read on EVERY call (never cached): the one source for startup, confirm, retry and the UI state. */
export const isBroadcastWorkerEnabled = (): boolean => process.env[BROADCAST_WORKER_FLAG] === 'true';
export const broadcastWorkerEnabled = isBroadcastWorkerEnabled;
export const BROADCAST_WORKER_DISABLED = 'BROADCAST_WORKER_DISABLED';
const workerDisabled = () => new AppError('الإرسال الجماعي غير مفعّل في هذه البيئة، لذلك لم يُنشأ أي إرسال ولم يُحفظ شيء. المسودة باقية ويمكن إرسالها لاحقًا عند التفعيل.', 503, undefined, BROADCAST_WORKER_DISABLED);
export function startBroadcastWorkerFromEnv() {
	if (!isBroadcastWorkerEnabled()) { logger.info(`[admin-broadcast] background delivery is OFF (${BROADCAST_WORKER_FLAG} is not "true"); confirmed broadcasts wait in the queue`); return null; }
	return startBroadcastWorker();
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
	if (!isBroadcastWorkerEnabled()) throw workerDisabled(); // before ANY write: no job, no recipients, no key consumed, draft untouched

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
	const result = await summary(broadcastId); // confirm = enqueue: delivery belongs to the worker
	await adminAudit.record({ adminId, entity: 'BROADCAST', entityId: broadcastId, eventType: 'BROADCAST_SENT', title: 'تأكيد إرسال إشعار جماعي داخل المنصة', summary: 'أكّد مدير النظام إرسال إشعار جماعي داخل المنصة (يُسلَّم في الخلفية).', severity: 'WARNING',
		details: { audience: draft.audience, category: draft.category, audienceCount: snap.count } });
	return { broadcast: result, replayed: false };
}

export async function retryRemaining(adminId: string, id: string) {
	if (!isBroadcastWorkerEnabled()) throw workerDisabled();
	const found = await prisma.broadcast.findUnique({ where: { id }, select: { id: true } });
	if (!found) throw new AppError('الإشعار الجماعي غير موجود.', 404);
	await prisma.$transaction(async tx => {
		await lock(tx, id);
		const b = await tx.broadcast.findUniqueOrThrow({ where: { id }, select: { status: true, createdAt: true, approvedAt: true } });
		if (b.status === 'CANCELLED') throw new AppError('أُلغي هذا الإرسال ولا يمكن إعادته.', 409, undefined, 'BROADCAST_CANCELLED');
		if (b.status === 'COMPLETED') throw new AppError('اكتمل الإرسال لكل المستلمين. لا يوجد ما يُعاد.', 409, undefined, 'BROADCAST_NOTHING_TO_RETRY');
		if (b.status === 'QUEUED' || b.status === 'SENDING') throw new AppError('الإرسال جارٍ أو في قائمة الانتظار. انتظر انتهاءه.', 409, undefined, 'BROADCAST_IN_PROGRESS');
		await tx.broadcastRecipient.updateMany({ where: { broadcastId: id, status: 'FAILED' }, data: { status: 'PENDING' } });
		await tx.broadcast.update({ where: { id }, data: { status: 'QUEUED', completedAt: null, leaseOwner: null, leaseUntil: null, ...(!b.approvedAt && Date.now() - b.createdAt.getTime() > maxQueueAgeMs() ? { approvedAt: new Date(), approvedById: adminId, approveReason: 'إعادة المحاولة بقرار صريح من مدير النظام' } : {}) } });
	});
	await adminAudit.record({ adminId, entity: 'BROADCAST', entityId: id, eventType: 'BROADCAST_RETRIED', title: 'إعادة إرسال المتبقي من إشعار جماعي', summary: 'أعاد مدير النظام المستلمين الفاشلين إلى قائمة الانتظار.', severity: 'WARNING' });
	return summary(id);
}

/** The caller's newest broadcast that is still QUEUED/SENDING (restores the running screen after a refresh). */
export async function activeBroadcast(adminId: string) {
	const b = await prisma.broadcast.findFirst({ where: { senderId: adminId, status: { in: ['QUEUED', 'SENDING'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
	return b ? summary(b.id) : null;
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

/** test seam: deliver as a given owner without claiming (to prove a non-owner stops) */
export const processBroadcastForTest = processBroadcast;

// ---- queue review ---------------------------------------------------------------------------------------------------------------------------------
export type QueueState = 'WAITING_WORKER_DISABLED' | 'WAITING_FOR_WORKER' | 'RUNNING' | 'STUCK_STOPPED_MID_RUN' | 'STUCK_NO_PROGRESS' | 'EXPIRED_NEEDS_REVIEW';
/** EXPIRED_NEEDS_REVIEW is DERIVED (age > max age, not re-approved), not a stored status: no enum value is needed and it follows the env limit live. */
export function classifyQueueState(b: { status: string; createdAt: Date; heartbeatAt: Date | null; leaseUntil: Date | null; approvedAt?: Date | null }, progressed: boolean, now: Date, workerEnabled: boolean): QueueState {
	const t = now.getTime();
	const quiet = t - (b.heartbeatAt ?? b.createdAt).getTime(); // time since the last sign of life
	if (b.status === 'SENDING' && b.leaseUntil && b.leaseUntil.getTime() > t) return 'RUNNING';
	if (!b.approvedAt && t - b.createdAt.getTime() > maxQueueAgeMs()) return 'EXPIRED_NEEDS_REVIEW';
	if ((b.status === 'SENDING' || progressed) && quiet > broadcastDeps.stuckMidRunMs) return 'STUCK_STOPPED_MID_RUN';
	if (!workerEnabled) return 'WAITING_WORKER_DISABLED';
	if (b.status === 'QUEUED' && !progressed && t - b.createdAt.getTime() > broadcastDeps.stuckNoProgressMs) return 'STUCK_NO_PROGRESS';
	return 'WAITING_FOR_WORKER';
}
const queueSelect = { ...listSelect, leaseUntil: true, reviewedAt: true, approvedAt: true } as const;
async function queueRows(limit = 100) {
	const rows = await prisma.broadcast.findMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, select: queueSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
	const counts = await recipientCounts(rows.map(r => r.id));
	const now = new Date(); const enabled = isBroadcastWorkerEnabled();
	return rows.map(b => {
		const c = counts.get(b.id)!; const queueState = classifyQueueState(b, c.SENT + c.FAILED > 0, now, enabled);
		const { title: _t, ...rest } = view(b, c);
		return { ...rest, title: b.title, queueState, stale: queueState.startsWith('STUCK'), waitingSeconds: b.status === 'QUEUED' ? Math.max(0, Math.floor((now.getTime() - b.createdAt.getTime()) / 1000)) : null, heartbeatAt: b.heartbeatAt, leaseUntil: b.leaseUntil, ageSeconds: Math.max(0, Math.floor((now.getTime() - b.createdAt.getTime()) / 1000)), reviewed: !!b.reviewedAt, approved: !!b.approvedAt };
	});
}
function summarizeQueue(items: Awaited<ReturnType<typeof queueRows>>) {
	const n = (s: QueueState) => items.filter(i => i.queueState === s).length;
	const waiting = items.filter(i => i.queueState === 'WAITING_WORKER_DISABLED' || i.queueState === 'WAITING_FOR_WORKER' || i.status === 'QUEUED');
	const ages = waiting.map(i => i.waitingSeconds).filter((x): x is number => x !== null);
	return { waitingDisabled: n('WAITING_WORKER_DISABLED'), waitingForWorker: n('WAITING_FOR_WORKER'), running: n('RUNNING'), stuckMidRun: n('STUCK_STOPPED_MID_RUN'), stuckNoProgress: n('STUCK_NO_PROGRESS'), expiredNeedsReview: n('EXPIRED_NEEDS_REVIEW'), oldestWaitingSeconds: ages.length ? Math.max(...ages) : null, workerEnabled: isBroadcastWorkerEnabled() };
}
export async function queueReview() { const items = await queueRows(); return { items, summary: summarizeQueue(items) }; }
export async function queueSummary() { return summarizeQueue(await queueRows()); }

/** Cancels a QUEUED job or a stuck/stopped SENDING job. SENT recipients are never touched; a live lease is respected. Idempotent. */
export async function cancelBroadcast(adminId: string, id: string, reason?: string) {
	const found = await prisma.broadcast.findUnique({ where: { id }, select: { id: true } });
	if (!found) throw new AppError('الإشعار الجماعي غير موجود.', 404);
	const changed = await prisma.$transaction(async tx => {
		await lock(tx, id);
		const b = await tx.broadcast.findUniqueOrThrow({ where: { id }, select: { status: true, leaseUntil: true } });
		if (b.status === 'CANCELLED') return false;
		if (b.status !== 'QUEUED' && b.status !== 'SENDING') throw new AppError('لا يمكن إلغاء إرسال انتهى.', 409, undefined, 'BROADCAST_NOT_CANCELLABLE');
		if (b.status === 'SENDING' && b.leaseUntil && b.leaseUntil.getTime() > Date.now()) throw new AppError('الإرسال يعمل الآن بواسطة العامل. لا يمكن إلغاؤه أثناء التنفيذ.', 409, undefined, 'BROADCAST_RUNNING');
		await tx.broadcastRecipient.updateMany({ where: { broadcastId: id, status: 'PENDING' }, data: { status: 'CANCELLED', updatedAt: new Date() } });
		await tx.broadcast.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date(), cancelledAt: new Date(), cancelledById: adminId, cancelReason: reason || null, leaseOwner: null, leaseUntil: null } });
		return true;
	});
	if (changed) await adminAudit.record({ adminId, entity: 'BROADCAST', entityId: id, eventType: 'BROADCAST_CANCELLED', title: 'إلغاء إرسال جماعي', summary: 'ألغى مدير النظام إرسالًا جماعيًا لم يكتمل.', severity: 'WARNING', details: reason ? { reason } : undefined });
	return summary(id);
}

// ---- pre-activation check, review, re-approval ----------------------------------------------------------------------------------------------------
export async function queuePreflight() {
	const items = await queueRows(1000);
	const count = (s: QueueState) => items.filter(i => i.queueState === s).length;
	const counts = { WAITING_WORKER_DISABLED: count('WAITING_WORKER_DISABLED'), WAITING_FOR_WORKER: count('WAITING_FOR_WORKER'), RUNNING: count('RUNNING'), STUCK_STOPPED_MID_RUN: count('STUCK_STOPPED_MID_RUN'), STUCK_NO_PROGRESS: count('STUCK_NO_PROGRESS'), EXPIRED_NEEDS_REVIEW: count('EXPIRED_NEEDS_REVIEW') };
	const blockers: { code: string; count: number; message: string }[] = [];
	const hours = Math.round(maxQueueAgeMs() / 3_600_000 * 100) / 100;
	if (counts.EXPIRED_NEEDS_REVIEW) blockers.push({ code: 'EXPIRED_JOBS', count: counts.EXPIRED_NEEDS_REVIEW, message: `إرسالات أقدم من ${hours} ساعة ولم يُعاد اعتمادها. العامل لن يرسلها قبل الاعتماد؛ ألغِها أو اعتمدها.` });
	if (counts.STUCK_STOPPED_MID_RUN) blockers.push({ code: 'STUCK_MID_RUN', count: counts.STUCK_STOPPED_MID_RUN, message: 'إرسالات توقفت أثناء التنفيذ. راجعها: استكمالها آمن بلا تكرار، أو ألغِها.' });
	if (counts.STUCK_NO_PROGRESS) blockers.push({ code: 'STUCK_NO_PROGRESS', count: counts.STUCK_NO_PROGRESS, message: 'إرسالات عالقة بلا تقدّم. راجعها أو ألغِها.' });
	const unreviewed = items.filter(i => !i.reviewed && i.queueState !== 'RUNNING').length;
	if (unreviewed) blockers.push({ code: 'UNREVIEWED_JOBS', count: unreviewed, message: 'إرسالات في الطابور لم تُراجَع بعد. راجعها واقبلها أو ألغِها قبل تفعيل العامل.' });
	const ages = items.map(i => i.ageSeconds);
	return {
		canEnableSafely: blockers.length === 0, blockers, counts, jobs: items.length, oldestAgeSeconds: ages.length ? Math.max(...ages) : null,
		thresholds: { maxQueueAgeSeconds: Math.round(maxQueueAgeMs() / 1000), stuckMidRunSeconds: Math.round(broadcastDeps.stuckMidRunMs / 1000), stuckNoProgressSeconds: Math.round(broadcastDeps.stuckNoProgressMs / 1000) },
		workerEnabled: isBroadcastWorkerEnabled(),
	};
}

async function ackTransition(adminId: string, id: string, kind: 'review' | 'approve', reason?: string) {
	const found = await prisma.broadcast.findUnique({ where: { id }, select: { id: true } });
	if (!found) throw new AppError('الإشعار الجماعي غير موجود.', 404);
	const changed = await prisma.$transaction(async tx => {
		await lock(tx, id);
		const b = await tx.broadcast.findUniqueOrThrow({ where: { id }, select: { status: true, createdAt: true, reviewedAt: true, approvedAt: true } });
		if (b.status !== 'QUEUED' && b.status !== 'SENDING') throw new AppError(b.status === 'CANCELLED' ? 'أُلغي هذا الإرسال.' : 'انتهى هذا الإرسال.', 409, undefined, kind === 'review' ? 'BROADCAST_NOT_REVIEWABLE' : 'BROADCAST_NOT_APPROVABLE');
		const now = new Date();
		if (kind === 'review') {
			if (b.reviewedAt) return false;
			await tx.broadcast.update({ where: { id }, data: { reviewedAt: now, reviewedById: adminId } });
			return true;
		}
		if (b.approvedAt) return false;
		if (now.getTime() - b.createdAt.getTime() <= maxQueueAgeMs()) throw new AppError('هذا الإرسال لم تنتهِ صلاحيته ولا يحتاج اعتمادًا.', 409, undefined, 'BROADCAST_NOT_EXPIRED');
		await tx.broadcast.update({ where: { id }, data: { approvedAt: now, approvedById: adminId, approveReason: reason ?? null, reviewedAt: b.reviewedAt ?? now, reviewedById: adminId } });
		return true;
	});
	if (changed) await adminAudit.record(kind === 'review'
		? { adminId, entity: 'BROADCAST', entityId: id, eventType: 'BROADCAST_REVIEWED', title: 'مراجعة إرسال جماعي', summary: 'راجع مدير النظام إرسالًا جماعيًا في الطابور وقبله.', severity: 'INFO' }
		: { adminId, entity: 'BROADCAST', entityId: id, eventType: 'BROADCAST_REAPPROVED', title: 'إعادة اعتماد إرسال جماعي منتهي الصلاحية', summary: 'أعاد مدير النظام اعتماد إرسال جماعي تجاوز مدة الطابور.', severity: 'WARNING', details: { reason } });
	return summary(id);
}
export const reviewBroadcast = (adminId: string, id: string) => ackTransition(adminId, id, 'review');
export const approveExpiredBroadcast = (adminId: string, id: string, reason: string) => ackTransition(adminId, id, 'approve', reason);
