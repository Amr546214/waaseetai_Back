import { Prisma, AccountType } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { adminRecipientsHolding } from './admin-access.service';
import { getSocketServer } from '../utils/socket-registry';
import { AppError, fieldError } from '../utils/app-error';

/**
 * Admin team messaging: direct staff <-> staff conversations, isolated from the customer / project chat (own tables, routes and socket rooms). Every read and write goes through the caller's
 * MEMBERSHIP of the conversation; holding the admin permission alone never opens anybody else's conversation, and a SUPER_ADMIN has no hidden read-all.
 */
export const MESSAGE_PERMISSION = 'messages.use';
export const MAX_BODY = 4000;
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const adminMsgRoom = (userId: string) => `adminmsg_${userId}`;
export const COUNTERPART_UNAVAILABLE = 'COUNTERPART_UNAVAILABLE';
export const CLIENT_MESSAGE_ID_CONFLICT = 'CLIENT_MESSAGE_ID_CONFLICT';

const pairKey = (a: string, b: string) => [a, b].sort().join(':');
const NOT_FOUND = () => new AppError('المحادثة غير موجودة', 404);
const nameOf = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();
const roleLabel = (u: { accountType: AccountType; adminStaff?: { role?: { name: string } | null } | null }) => (u.accountType === AccountType.SUPER_ADMIN ? 'مدير النظام' : u.adminStaff?.role?.name ?? '');
const userSelect = { id: true, firstName: true, lastName: true, accountType: true, adminStaff: { select: { role: { select: { name: true } } } } } as const;
const cleanBody = (v: unknown): string => {
	const b = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
	if (!b) throw fieldError('body', 'اكتب رسالة قبل الإرسال');
	if (b.length > MAX_BODY) throw fieldError('body', `الرسالة أطول من ${MAX_BODY} حرف`);
	return b;
};
const asMessage = (m: { id: string; conversationId: string; senderId: string; clientMessageId: string; body: string; seq: bigint; createdAt: Date }) =>
	({ id: m.id, conversationId: m.conversationId, senderId: m.senderId, clientMessageId: m.clientMessageId, body: m.body, seq: m.seq.toString(), createdAt: m.createdAt });
const emit = (userIds: string[], event: string, payload: unknown) => { try { const io = getSocketServer(); if (io) for (const u of userIds) io.to(adminMsgRoom(u)).emit(event, payload); } catch { /* live push is best effort; the saved row is the truth */ } };

export class AdminMessagesService {
	constructor(private db: typeof defaultPrisma = defaultPrisma) {}

	/** The one place that decides whether a conversation is the caller's: a member row. Anything else is "not found" (no existence leak). */
	private async membership(conversationId: string, userId: string) {
		if (!conversationId) throw NOT_FOUND();
		const m = await this.db.adminConversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } }, include: { conversation: { include: { members: { include: { user: { select: userSelect } } } } } } });
		if (!m) throw NOT_FOUND();
		return m;
	}

	/** Other members of the team the caller may start a conversation with: ACTIVE accounts that hold the messaging permission right now (never a client / provider / marketer). */
	async directory(me: string, search?: string) {
		const holders = (await adminRecipientsHolding(MESSAGE_PERMISSION, this.db)).filter(id => id !== me);
		const q = (search ?? '').trim();
		const users = await this.db.user.findMany({
			where: { id: { in: holders }, ...(q ? { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } : {}) },
			select: userSelect, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }], take: 200,
		});
		return users.map(u => ({ userId: u.id, name: nameOf(u), role: roleLabel(u) }));
	}

	async startConversation(me: string, otherId: unknown) {
		const other = typeof otherId === 'string' ? otherId : '';
		if (!other) throw fieldError('userId', 'اختر موظفًا');
		if (other === me) throw fieldError('userId', 'لا يمكن مراسلة نفسك');
		const eligible = await adminRecipientsHolding(MESSAGE_PERMISSION, this.db);
		if (!eligible.includes(other)) throw new AppError('هذا الموظف غير متاح للمراسلة', 404, undefined, COUNTERPART_UNAVAILABLE);
		const key = pairKey(me, other);
		let conv = await this.db.adminConversation.findUnique({ where: { pairKey: key } });
		if (!conv) {
			try {
				conv = await this.db.adminConversation.create({ data: { pairKey: key, members: { create: [{ userId: me }, { userId: other }] } } });
			} catch (e) {
				if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') conv = await this.db.adminConversation.findUniqueOrThrow({ where: { pairKey: key } });
				else throw e;
			}
		}
		return this.summary(conv.id, me);
	}

	private async summary(conversationId: string, me: string) {
		const m = await this.membership(conversationId, me);
		const other = m.conversation.members.find(x => x.userId !== me)!;
		const [last, unread] = await Promise.all([
			this.db.adminMessage.findFirst({ where: { conversationId }, orderBy: { seq: 'desc' } }),
			this.db.adminMessage.count({ where: { conversationId, senderId: { not: me }, seq: { gt: m.lastReadSeq } } }),
		]);
		return {
			id: conversationId, counterpart: { userId: other.userId, name: nameOf(other.user), role: roleLabel(other.user) },
			lastMessage: last ? { body: last.body.slice(0, 140), at: last.createdAt, mine: last.senderId === me } : null, lastMessageAt: m.conversation.lastMessageAt, unread,
		};
	}

	async list(me: string, search?: string) {
		const q = (search ?? '').trim();
		const rows = await this.db.adminConversationMember.findMany({
			where: { userId: me, ...(q ? { conversation: { OR: [{ members: { some: { userId: { not: me }, user: { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } } } }, { messages: { some: { body: { contains: q, mode: 'insensitive' } } } }] } } : {}) },
			select: { conversationId: true, conversation: { select: { lastMessageAt: true, createdAt: true } } },
		});
		rows.sort((a, b) => +(b.conversation.lastMessageAt ?? b.conversation.createdAt) - +(a.conversation.lastMessageAt ?? a.conversation.createdAt));
		return Promise.all(rows.slice(0, 100).map(r => this.summary(r.conversationId, me)));
	}

	async messages(me: string, conversationId: string, opts: { before?: unknown; limit?: unknown }) {
		await this.membership(conversationId, me);
		const limit = Math.min(Math.max(parseInt(String(opts.limit ?? 50), 10) || 50, 1), 100);
		let before: bigint | undefined; if (opts.before !== undefined && opts.before !== '') { if (!/^\d{1,18}$/.test(String(opts.before))) throw fieldError('before', 'قيمة غير صالحة'); before = BigInt(String(opts.before)); }
		const rows = await this.db.adminMessage.findMany({ where: { conversationId, ...(before !== undefined ? { seq: { lt: before } } : {}) }, orderBy: { seq: 'desc' }, take: limit + 1 });
		const page = rows.slice(0, limit).reverse();
		return { messages: page.map(asMessage), hasMore: rows.length > limit };
	}

	/** Idempotent: the same (conversation, sender, clientMessageId) returns the already-saved row and pushes nothing twice. */
	async send(me: string, conversationId: string, input: { body?: unknown; clientMessageId?: unknown }) {
		const body = cleanBody(input.body);
		const cid = typeof input.clientMessageId === 'string' ? input.clientMessageId : '';
		if (!CLIENT_ID_RE.test(cid)) throw fieldError('clientMessageId', 'معرّف الإرسال مطلوب');
		const m = await this.membership(conversationId, me);
		const other = m.conversation.members.find(x => x.userId !== me)!;
		const existing = await this.db.adminMessage.findUnique({ where: { conversationId_senderId_clientMessageId: { conversationId, senderId: me, clientMessageId: cid } } });
		const conflict = () => new AppError('معرّف الإرسال هذا استُخدم لرسالة أخرى. أعد المحاولة بإرسال جديد.', 409, undefined, CLIENT_MESSAGE_ID_CONFLICT);
		if (existing) { if (existing.body !== body) throw conflict(); return { message: asMessage(existing), duplicate: true }; }
		if (!(await adminRecipientsHolding(MESSAGE_PERMISSION, this.db)).includes(other.userId)) throw new AppError('هذا الموظف لم يعد متاحًا للمراسلة', 409, undefined, COUNTERPART_UNAVAILABLE);
		let saved; let duplicate = false;
		try {
			saved = await this.db.$transaction(async tx => {
				const row = await tx.adminMessage.create({ data: { conversationId, senderId: me, clientMessageId: cid, body } });
				await tx.adminConversation.update({ where: { id: conversationId }, data: { lastMessageAt: row.createdAt } });
				return row;
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') { saved = await this.db.adminMessage.findUniqueOrThrow({ where: { conversationId_senderId_clientMessageId: { conversationId, senderId: me, clientMessageId: cid } } }); if (saved.body !== body) throw conflict(); duplicate = true; }
			else throw e;
		}
		if (!duplicate) {
			const message = asMessage(saved);
			emit([me, other.userId], 'admin_message_new', { conversationId, message });
		}
		return { message: asMessage(saved), duplicate };
	}

	/** Read means the member said so (the page is open on that conversation), never that a message merely arrived. Only moves forward. */
	async markRead(me: string, conversationId: string, upToSeq: unknown) {
		const m = await this.membership(conversationId, me);
		if (!/^\d{1,18}$/.test(String(upToSeq ?? ''))) throw fieldError('upToSeq', 'قيمة غير صالحة');
		const latest = await this.db.adminMessage.findFirst({ where: { conversationId }, orderBy: { seq: 'desc' }, select: { seq: true } });
		let target = BigInt(String(upToSeq)); if (latest && target > latest.seq) target = latest.seq; if (!latest) target = BigInt(0);
		if (target > m.lastReadSeq) await this.db.adminConversationMember.updateMany({ where: { conversationId, userId: me, lastReadSeq: { lt: target } }, data: { lastReadSeq: target } });
		const s = await this.summary(conversationId, me);
		emit([me], 'admin_read_sync', { conversationId, unread: s.unread, total: await this.unreadTotal(me) });
		return { conversationId, unread: s.unread };
	}

	async unreadTotal(me: string): Promise<number> {
		const ms = await this.db.adminConversationMember.findMany({ where: { userId: me }, select: { conversationId: true, lastReadSeq: true } });
		const counts = await Promise.all(ms.map(m => this.db.adminMessage.count({ where: { conversationId: m.conversationId, senderId: { not: me }, seq: { gt: m.lastReadSeq } } })));
		return counts.reduce((a, b) => a + b, 0);
	}
}
export const adminMessagesService = new AdminMessagesService();
