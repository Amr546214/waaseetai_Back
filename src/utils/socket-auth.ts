import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { prisma } from '../config/db';
import { sessionService } from '../services/session.service';
import { ACCOUNT_NOT_ACTIVE_CODE, ACCOUNT_NOT_ACTIVE_MESSAGE } from './socket-registry';

// One handshake check for every socket gateway (AUD-FND-000035): the token must be a valid JWT, its session must be live (not revoked / expired)
// and the account must be ACTIVE and not banned. PENDING_VERIFICATION, SUSPENDED and SUSPENDED_REVIEW are all refused.
export type SocketAuthResult =
	| { ok: true; userId: string; accountType: string }
	| { ok: false; reason: 'NO_TOKEN' | 'INVALID_TOKEN' | 'SESSION_REVOKED' | 'NOT_FOUND' | 'NOT_ACTIVE' };

export function cleanToken(raw: unknown): string | null {
	if (typeof raw !== 'string' || !raw) return null;
	let t = raw.trim();
	if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
	if (t.startsWith('Bearer ')) t = t.slice(7);
	return t || null;
}

export function handshakeToken(socket: Socket): string | null {
	const h: any = socket.handshake;
	return cleanToken(h?.auth?.token) ?? cleanToken(h?.headers?.authorization);
}

export async function verifySocketToken(rawToken: unknown, context: { ipAddress?: string; userAgent?: string } = {}): Promise<SocketAuthResult> {
	const token = cleanToken(rawToken);
	const secret = process.env.JWT_SECRET;
	if (!token) return { ok: false, reason: 'NO_TOKEN' };
	if (!secret) return { ok: false, reason: 'INVALID_TOKEN' };
	let decoded: { userId?: string; id?: string; exp?: number };
	try { decoded = jwt.verify(token, secret) as typeof decoded; } catch { return { ok: false, reason: 'INVALID_TOKEN' }; }
	const userId = decoded.userId || decoded.id;
	if (!userId) return { ok: false, reason: 'INVALID_TOKEN' };

	const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, accountType: true, isBanned: true } });
	if (!user) return { ok: false, reason: 'NOT_FOUND' };
	if (user.isBanned || user.status !== 'ACTIVE') return { ok: false, reason: 'NOT_ACTIVE' };
	const session = await sessionService.validateOrRegister(userId, token, context, decoded.exp ? new Date(decoded.exp * 1000) : undefined);
	if (!session) return { ok: false, reason: 'SESSION_REVOKED' };
	return { ok: true, userId, accountType: String(user.accountType) };
}

const refusal = (reason: string) => Object.assign(new Error(reason === 'NOT_ACTIVE' ? ACCOUNT_NOT_ACTIVE_MESSAGE : 'Authentication failed'), {
	data: { code: reason === 'NOT_ACTIVE' ? ACCOUNT_NOT_ACTIVE_CODE : reason }
});

/**
 * Handshake middleware.
 *  - `required: false` (main namespace, which also serves public pages): no token or a token that is not a valid JWT connects as an anonymous
 *    socket (exactly as before, it has no userId); a VALID token whose account is not active / session is revoked is REFUSED.
 *  - `required: true` (/assessments): anything but an active account is refused.
 * On success it sets socket.userId / socket.data.userId (the single source the gateways read).
 */
export function socketAuthMiddleware(options: { required: boolean; onAuthenticated?: (socket: Socket, userId: string) => void }) {
	return async (socket: Socket, next: (err?: Error) => void) => {
		try {
			const token = handshakeToken(socket);
			if (!token) return options.required ? next(refusal('NO_TOKEN')) : next();
			const result = await verifySocketToken(token, { ipAddress: socket.handshake?.address, userAgent: (socket.handshake as any)?.headers?.['user-agent'] });
			if (!result.ok) {
				if (!options.required && (result.reason === 'INVALID_TOKEN' || result.reason === 'NO_TOKEN')) return next();
				return next(refusal(result.reason));
			}
			(socket as any).userId = result.userId;
			socket.data = { ...(socket.data ?? {}), userId: result.userId };
			options.onAuthenticated?.(socket, result.userId);
			next();
		} catch {
			next(refusal('INVALID_TOKEN'));
		}
	};
}
