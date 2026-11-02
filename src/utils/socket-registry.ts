import type { Server } from 'socket.io';

// The live Socket.IO server, registered by socket.ts. Kept in a tiny module so services (e.g. the admin status change) can cut a suspended
// user's live connections without importing the whole socket stack.
let server: Server | null = null;
export const setSocketServer = (s: Server | null): void => { server = s; };
export const getSocketServer = (): Server | null => server;

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

export const ADMIN_ACCESS_CHANGED_CODE = 'ADMIN_ACCESS_CHANGED';

/**
 * Cuts the live sockets of staff whose admin access was just suspended, re-roled or reduced, after telling them (`admin_access_changed`). The client reconnects and starts again from what it now
 * holds, so no subscription or open connection outlives the access that opened it. Best effort and never throws: the database already refuses the next request regardless.
 */
export async function disconnectAdminSockets(userIds: string[]): Promise<number> {
	if (!server || userIds.length === 0) return 0;
	const wanted = new Set(userIds);
	let cut = 0;
	try {
		for (const namespace of [server.of('/'), server.of('/assessments')]) {
			for (const s of await namespace.fetchSockets()) {
				const owner = (s.data as { userId?: string } | undefined)?.userId;
				if (!owner || !wanted.has(owner)) continue;
				s.emit('admin_access_changed', { code: ADMIN_ACCESS_CHANGED_CODE, message: 'تغيّرت صلاحياتك. أُعيد الاتصال بما تملكه الآن.' });
				s.disconnect(true);
				cut++;
			}
		}
	} catch { /* best effort */ }
	return cut;
}
