import type { Server } from 'socket.io';

// The live Socket.IO server, registered by socket.ts. Kept in a tiny module so services (e.g. the admin status change) can cut a suspended
// user's live connections without importing the whole socket stack.
let server: Server | null = null;
export const setSocketServer = (s: Server | null): void => { server = s; };

export const ACCOUNT_NOT_ACTIVE_CODE = 'ACCOUNT_NOT_ACTIVE';
export const ACCOUNT_NOT_ACTIVE_MESSAGE = 'تم إيقاف الاتصال لأن حسابك لم يعد نشطًا.';

/**
 * Disconnects every live socket of a user (main namespace + /assessments), after telling it why (`account_not_active`). Used when an admin
 * moves the account out of ACTIVE. Returns how many sockets were cut. A no-op when no server is registered (tests, scripts).
 */
export async function disconnectUserSockets(userId: string): Promise<number> {
	if (!server) return 0;
	let cut = 0;
	for (const namespace of [server.of('/'), server.of('/assessments')]) {
		const sockets = await namespace.fetchSockets();
		for (const s of sockets) {
			const owner = (s.data as { userId?: string } | undefined)?.userId;
			if (owner !== userId) continue;
			s.emit('account_not_active', { code: ACCOUNT_NOT_ACTIVE_CODE, message: ACCOUNT_NOT_ACTIVE_MESSAGE });
			s.disconnect(true);
			cut++;
		}
	}
	return cut;
}
