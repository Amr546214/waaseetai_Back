import type { Socket } from 'socket.io';
import { prisma } from '../config/db';
import { actorHas, resolveAdminActor } from '../services/admin-access.service';
import { adminMsgRoom, MESSAGE_PERMISSION } from '../services/admin-messages.service';

/**
 * Live side of the admin team messaging. A socket may only listen to ITS OWN account's room (`adminmsg_<userId>`), and only while that account is a SUPER_ADMIN or an ACTIVE staff member holding
 * `messages.use`, checked against the database at the moment of the request. Events carry only conversations the account is a member of (the server pushes by membership). Access withdrawal
 * cuts the socket (disconnectAdminSockets), and a reconnect is refused here.
 */
export function registerAdminMessagesGateway(socket: Socket): void {
	socket.on('admin_messages_subscribe', async (_payload: unknown, ack?: (r: { ok: boolean; code?: string }) => void) => {
		const reply = (r: { ok: boolean; code?: string }) => { if (typeof ack === 'function') ack(r); };
		try {
			const userId = (socket as any).userId as string | undefined;
			if (!userId) return reply({ ok: false, code: 'UNAUTHENTICATED' });
			const u = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true, status: true, isBanned: true } });
			if (!u || u.status !== 'ACTIVE' || u.isBanned) return reply({ ok: false, code: 'ACCOUNT_NOT_ACTIVE' });
			const actor = await resolveAdminActor(userId, u.accountType);
			if (!actorHas(actor, MESSAGE_PERMISSION)) return reply({ ok: false, code: 'ADMIN_PERMISSION_DENIED' });
			await socket.join(adminMsgRoom(userId));
			reply({ ok: true });
		} catch { reply({ ok: false, code: 'ADMIN_ACCESS_UNAVAILABLE' }); }
	});
	socket.on('admin_messages_unsubscribe', () => { const userId = (socket as any).userId as string | undefined; if (userId) void socket.leave(adminMsgRoom(userId)); });
}
