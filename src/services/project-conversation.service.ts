import { ConversationKind, MessageStatus, MessageType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { getSocketServer } from '../utils/socket-registry';

/**
 * PROJECT message context (spec §10).
 *
 * A project room is the ONE Conversation bound to a contract and its two parties (Conversation.contractId is unique): the project's «الرسائل» tab shows it and
 * the general messages list does not. Everything else (negotiation rooms and every row that existed before this release) is the GENERAL context.
 *
 * Nothing here moves, relabels or deletes a historical row on its own:
 *  - a contract that already has a project room -> that room;
 *  - else a conversation already exists for the same project + the contract's two parties (the old shared room): it keeps being used AS IS
 *    (`legacyShared: true`, still GENERAL, still in the general list) until the separately approved backfill relabels it
 *    (docs/proposals/project-message-context-migration-preview.md);
 *  - else a PROJECT room is created, race-safe (unique contractId + unique (projectId, providerId)): the loser of a concurrent create re-reads the winner's row.
 * The only automatic link is FORWARD-ONLY: with PROJECT_ROOM_LINK_CONTRACTS_FROM set (ISO date, set at deploy time by the orchestrator), the negotiation room of a
 * contract created at/after that instant becomes its project room on first use (same row, no message moved). Unset = never.
 */

type Db = typeof prisma | Prisma.TransactionClient;

export type ProjectRoomContract = { id: string; projectId: string; clientId: string; providerId: string; offerId?: string | null; createdAt?: Date | null };

export type ProjectRoom = { id: string; kind: ConversationKind; contractId: string | null; projectId: string; clientId: string; providerId: string; legacyShared: boolean };

/** Socket.IO room of a conversation: project rooms and general rooms never share a name. */
export const roomNameFor = (conv: { id: string; kind?: ConversationKind | string | null; contractId?: string | null }): string =>
	conv.kind === ConversationKind.PROJECT && conv.contractId ? `project_room_${conv.contractId}` : `conversation_${conv.id}`;

/**
 * The stable URL that opens the project's messages tab for ONE party. The project page keys on a project id OR a contract id; the contract id is used.
 * T5 (notifications) uses exactly this as the actionUrl of a project-message / project-event notification.
 */
export const projectMessagesUrl = (role: 'CLIENT' | 'PROVIDER' | UserRole | string, contractId: string): string =>
	role === 'PROVIDER'
		? `/provider-overview/projects/active/progress/${contractId}?tab=messages`
		: `/client-overview/projects/${contractId}?tab=messages`;

const ROOM_SELECT = { id: true, kind: true, contractId: true, projectId: true, clientId: true, providerId: true } as const;
const toRoom = (row: any, legacyShared: boolean): ProjectRoom => ({ id: row.id, kind: row.kind ?? ConversationKind.GENERAL, contractId: row.contractId ?? null, projectId: row.projectId, clientId: row.clientId, providerId: row.providerId, legacyShared });

const autoLinkFrom = (): Date | null => {
	const raw = process.env.PROJECT_ROOM_LINK_CONTRACTS_FROM;
	if (!raw) return null;
	const d = new Date(raw);
	return Number.isNaN(d.getTime()) ? null : d;
};

/** Idempotent get-or-create of the contract's project room. Safe under concurrent calls; never creates a second row for the same contract. */
export async function ensureProjectRoom(db: Db, contract: ProjectRoomContract, loaded?: any[]): Promise<ProjectRoom> {
	// `loaded`: ALL conversations of this project the caller already read (saves the lookups; same result as the queries). Absent: the database is asked.
	const byContract = loaded ? loaded.find(c => c.contractId === contract.id) : await db.conversation.findUnique({ where: { contractId: contract.id }, select: ROOM_SELECT });
	if (byContract) return toRoom(byContract, false);

	const pairWhere = { projectId_providerId: { projectId: contract.projectId, providerId: contract.providerId } };
	const existing = loaded ? loaded.find(c => c.providerId === contract.providerId && c.clientId === contract.clientId) : await db.conversation.findUnique({ where: pairWhere, select: ROOM_SELECT });
	if (existing) {
		// An existing room of another client on the same project/provider pair is never reused.
		if (existing.clientId !== contract.clientId) throw new AppError('تعذر تحديد غرفة رسائل المشروع', 409);
		const from = autoLinkFrom();
		if (from && existing.kind === ConversationKind.GENERAL && !existing.contractId && contract.createdAt && contract.createdAt >= from) {
			// Forward-only link of this contract's own negotiation room (one conditional update; a concurrent linker is a no-op).
			await db.conversation.updateMany({ where: { id: existing.id, contractId: null, kind: ConversationKind.GENERAL }, data: { kind: ConversationKind.PROJECT, contractId: contract.id } });
			const linked = await db.conversation.findUnique({ where: { id: existing.id }, select: ROOM_SELECT });
			if (linked?.contractId === contract.id) return toRoom(linked, false);
		}
		return toRoom(existing, !existing.contractId);
	}

	try {
		const created = await db.conversation.create({
			data: { projectId: contract.projectId, providerId: contract.providerId, clientId: contract.clientId, offerId: contract.offerId || null, kind: ConversationKind.PROJECT, contractId: contract.id },
			select: ROOM_SELECT
		});
		return toRoom(created, false);
	} catch (err: any) {
		if (err?.code !== 'P2002') throw err;
		// Lost the race: the winner's row is the room (found by contract, else by the project/provider pair).
		const winner = (await db.conversation.findUnique({ where: { contractId: contract.id }, select: ROOM_SELECT }))
			?? (await db.conversation.findUnique({ where: pairWhere, select: ROOM_SELECT }));
		if (!winner) throw err;
		return toRoom(winner, !winner.contractId);
	}
}

/**
 * Ownership of a project room: the contract must exist AND the user must be the contract's party that matches the CURRENT activeRole
 * (the same role isolation as chat.service.conversationRoleFilter). Anyone else (other client, other provider, wrong role) gets null.
 */
export async function authorizeProjectContract(userId: string, activeRole: UserRole | string | null | undefined, contractKey: string) {
	if (!userId || !contractKey) return null;
	const side = activeRole === UserRole.CLIENT ? { clientId: userId } : activeRole === UserRole.PROVIDER ? { providerId: userId } : null;
	if (!side) return null;
	// The project page is keyed by a contract id or a project id (Contract.projectId is unique): both resolve to the same contract.
	return prisma.contract.findFirst({
		where: { OR: [{ id: contractKey }, { projectId: contractKey }], ...side },
		select: { id: true, projectId: true, clientId: true, providerId: true, offerId: true, createdAt: true }
	});
}

/** What a conversation id is: used to redirect an old link (a general-list link to a project room) to the right context. */
export async function conversationContextFor(userId: string, activeRole: UserRole | string | null | undefined, conversationId: string) {
	const side = activeRole === UserRole.CLIENT ? { clientId: userId } : activeRole === UserRole.PROVIDER ? { providerId: userId } : null;
	if (!side) throw new AppError('المحادثة غير موجودة أو غير مصرح بالوصول', 403);
	const conv = await prisma.conversation.findFirst({ where: { id: conversationId, ...side }, select: { id: true, kind: true, contractId: true, projectId: true } });
	if (!conv) throw new AppError('المحادثة غير موجودة أو غير مصرح بالوصول', 403);
	if (conv.kind === ConversationKind.PROJECT && conv.contractId) {
		return { conversationId: conv.id, context: 'PROJECT' as const, contractId: conv.contractId, projectId: conv.projectId, url: projectMessagesUrl(activeRole as string, conv.contractId) };
	}
	return { conversationId: conv.id, context: 'GENERAL' as const, contractId: null, projectId: conv.projectId, url: null };
}

/** The project room of a contract the user owns (created on first use), with the caller's unread count. */
export async function getProjectRoomFor(userId: string, activeRole: UserRole | string | null | undefined, contractKey: string) {
	const contract = await authorizeProjectContract(userId, activeRole, contractKey);
	if (!contract) throw new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إلى رسائله', 403);
	const room = await ensureProjectRoom(prisma, contract);
	const unreadCount = await prisma.message.count({ where: { conversationId: room.id, senderId: { not: userId }, status: { not: MessageStatus.READ } } });
	return { conversationId: room.id, context: room.kind === ConversationKind.PROJECT ? 'PROJECT' as const : 'GENERAL' as const, legacyShared: room.legacyShared, contractId: contract.id, projectId: contract.projectId, unreadCount, url: projectMessagesUrl(activeRole as string, contract.id) };
}

export const SYSTEM_EVENT_KIND = 'PROJECT_EVENT';

/**
 * Appends ONE project event (a SYSTEM message) to the contract's project room. `eventKey` is deterministic and unique: a retried request or a socket echo
 * hits the unique index and creates nothing (returns created:false). Never throws: an event must not fail the business action that already committed.
 * `text` must contain no OTP / secret (callers pass only amounts, days and the amendment title).
 */
export async function appendProjectEvent(input: { contractId: string; eventKey: string; actorId: string; text: string; event: string; notBefore?: Date; meta?: Record<string, unknown> }): Promise<{ created: boolean; messageId?: string; createdAt?: Date }> {
	try {
		const contract = await prisma.contract.findUnique({ where: { id: input.contractId }, select: { id: true, projectId: true, clientId: true, providerId: true, offerId: true, createdAt: true } });
		if (!contract) return { created: false };
		const room = await ensureProjectRoom(prisma, contract);
		let message: any;
		try {
			message = await prisma.message.create({
				data: { conversationId: room.id, senderId: input.actorId, type: MessageType.SYSTEM, content: input.text, status: MessageStatus.SENT, eventKey: input.eventKey,
					// an event that follows another one (accepted -> applied) never ties with it: the order is the order of the real state changes
					...(input.notBefore ? { createdAt: new Date(Math.max(Date.now(), input.notBefore.getTime() + 1)) } : {}), context: { kind: SYSTEM_EVENT_KIND, event: input.event, ...(input.meta ?? {}) } as Prisma.InputJsonValue },
				include: { sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } }
			});
		} catch (err: any) {
			if (err?.code === 'P2002') return { created: false };
			throw err;
		}
		await prisma.conversation.update({ where: { id: room.id }, data: { updatedAt: new Date() } });
		await emitProjectEvent(contract, room, message, input);
		return { created: true, messageId: message.id, createdAt: message.createdAt };
	} catch (err) {
		console.error('[ProjectEvent] could not record the project event', input.eventKey, (err as Error)?.message);
		return { created: false };
	}
}

async function emitProjectEvent(contract: ProjectRoomContract, room: ProjectRoom, message: any, input: { event: string; meta?: Record<string, unknown> }) {
	try {
		const io = getSocketServer();
		if (!io) return;
		const payload = {
			id: message.id, conversationId: room.id, senderId: message.senderId, senderName: 'النظام', type: 'SYSTEM', text: message.content || '', createdAt: message.createdAt,
			status: message.status, conversationContext: room.kind === ConversationKind.PROJECT ? 'PROJECT' : 'GENERAL', contractId: contract.id, projectId: contract.projectId, event: input.event, ...(input.meta ?? {})
		};
		// The room carries the message to an open project tab; the personal rooms tell the amendment pages / badges (the same payload on both is de-duplicated by id in the FE).
		io.to(roomNameFor(room)).emit('new_message', payload);
		io.to(`user_${contract.clientId}`).to(`user_${contract.providerId}`).emit('project_event', payload);
	} catch (err) {
		console.error('[ProjectEvent] socket emit failed', (err as Error)?.message);
	}
}
