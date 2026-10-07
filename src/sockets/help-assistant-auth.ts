import type { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { sessionService } from '../services/session.service';

// Per-request authentication for the dashboard Help Assistant / Avatar
// (`help:ask`). The main Socket.IO namespace is soft-auth (a JWT in the
// handshake is optional, see socket.ts), so this gateway re-checks, on EVERY
// question, the same things the REST `authenticate` + `requireActiveUser`
// middleware check:
//   1. the socket was authenticated at handshake (socket.userId is set from a
//      verified JWT — never from a client payload),
//   2. the handshake JWT is still valid now (it may have expired since the
//      socket connected) and belongs to that same user,
//   3. the user still exists and is not pending verification, suspended or
//      banned,
//   4. the server-side session for that token is not revoked/expired.
// The account role is derived here from the DB, never from the payload.

export type HelpAssistantRole = 'client' | 'provider' | 'marketer' | 'admin';

export type HelpAssistantAuthResult =
	| { ok: true; userId: string; role: HelpAssistantRole }
	| { ok: false; reason: 'UNAUTHENTICATED' | 'FORBIDDEN' };

const BLOCKED_STATUSES = new Set(['PENDING_VERIFICATION', 'SUSPENDED', 'SUSPENDED_REVIEW']);

/** Maps the verified active role (multi-role users) or, failing that, the
 *  account type to one coarse dashboard role. Unknown → null (rejected). */
export function mapHelpAssistantRole(activeRole: string | null | undefined, accountType: string | null | undefined): HelpAssistantRole | null {
	// Admin account types win: `activeRole` defaults to CLIENT in the schema,
	// so an admin account often carries activeRole=CLIENT (seen locally).
	if (accountType === 'ADMIN' || accountType === 'SUPER_ADMIN') return 'admin';
	switch (activeRole) {
		case 'CLIENT': return 'client';
		case 'PROVIDER': return 'provider';
		case 'AFFILIATE': return 'marketer';
		case 'ADMIN':
		case 'SUPER_ADMIN': return 'admin';
	}
	switch (accountType) {
		case 'CLIENT_INDIVIDUAL':
		case 'CLIENT_COMPANY': return 'client';
		case 'PROVIDER_INDIVIDUAL':
		case 'PROVIDER_COMPANY': return 'provider';
		case 'MARKETING_BROKER': return 'marketer';
		case 'ADMIN':
		case 'SUPER_ADMIN': return 'admin';
	}
	return null;
}

function handshakeToken(socket: Socket): string | null {
	const fromAuth = (socket.handshake as any)?.auth?.token;
	if (typeof fromAuth === 'string' && fromAuth) return fromAuth;
	const header = (socket.handshake as any)?.headers?.authorization;
	if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
	return null;
}

export async function resolveHelpAssistantUser(socket: Socket): Promise<HelpAssistantAuthResult> {
	const socketUserId: unknown = (socket as any).userId;
	const token = handshakeToken(socket);
	const secret = process.env.JWT_SECRET;
	if (typeof socketUserId !== 'string' || !socketUserId || !token || !secret) return { ok: false, reason: 'UNAUTHENTICATED' };

	let decoded: { userId?: string; id?: string; exp?: number };
	try {
		decoded = jwt.verify(token, secret) as typeof decoded;
	} catch {
		return { ok: false, reason: 'UNAUTHENTICATED' };
	}
	if ((decoded.userId || decoded.id) !== socketUserId) return { ok: false, reason: 'UNAUTHENTICATED' };

	const user = await prisma.user.findUnique({
		where: { id: socketUserId },
		select: { accountType: true, status: true, activeRole: true, isBanned: true },
	});
	if (!user) return { ok: false, reason: 'UNAUTHENTICATED' };
	if (user.isBanned || BLOCKED_STATUSES.has(String(user.status))) return { ok: false, reason: 'FORBIDDEN' };

	const session = await sessionService.validateOrRegister(
		socketUserId,
		token,
		{ ipAddress: socket.handshake?.address, userAgent: (socket.handshake as any)?.headers?.['user-agent'] },
		decoded.exp ? new Date(decoded.exp * 1000) : undefined,
	);
	if (!session) return { ok: false, reason: 'UNAUTHENTICATED' };

	const role = mapHelpAssistantRole(user.activeRole as string | null, user.accountType as string | null);
	if (!role) return { ok: false, reason: 'FORBIDDEN' };
	return { ok: true, userId: socketUserId, role };
}
