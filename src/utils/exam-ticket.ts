import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

/**
 * A short-lived ticket that proves "this user, from this login session, passed the Safe Exam Browser check on the verified HTTP route a moment ago". It lets a SOCKET flow (the registration
 * setup test, whose transport cannot carry a per-request SEB hash) start in restricted mode without changing how that test runs. Single use, 3 minutes, bound to user + session + scope.
 * Signed with JWT_SECRET (same trust as the access token). It carries no SEB key and no answer; it is not a login.
 */
export const EXAM_TICKET_TTL_SECONDS = 180;
export type ExamTicketScope = 'SETUP_TEST';
const used = new Map<string, number>(); // jti -> expiry (ms): single use per process; the 3-minute life bounds any cross-instance replay
const sweep = () => { const now = Date.now(); for (const [k, e] of used) if (e < now) used.delete(k); };

export function issueExamTicket(userId: string, sessionId: string, scope: ExamTicketScope, env: NodeJS.ProcessEnv = process.env): { ticket: string; expiresAt: string } {
	const secret = env.JWT_SECRET; if (!secret) throw new Error('JWT_SECRET missing');
	const jti = randomUUID();
	const ticket = jwt.sign({ purpose: 'EXAM_ENV', scope, userId, sessionId }, secret, { expiresIn: EXAM_TICKET_TTL_SECONDS, jwtid: jti });
	return { ticket, expiresAt: new Date(Date.now() + EXAM_TICKET_TTL_SECONDS * 1000).toISOString() };
}

export function consumeExamTicket(ticket: unknown, expect: { userId: string; sessionId: string | undefined; scope: ExamTicketScope }, env: NodeJS.ProcessEnv = process.env): boolean {
	const secret = env.JWT_SECRET; if (!secret || typeof ticket !== 'string' || !ticket) return false;
	try {
		const p = jwt.verify(ticket, secret) as { purpose?: string; scope?: string; userId?: string; sessionId?: string; jti?: string; exp?: number };
		if (p.purpose !== 'EXAM_ENV' || p.scope !== expect.scope || p.userId !== expect.userId || !p.sessionId || p.sessionId !== expect.sessionId || !p.jti) return false;
		sweep();
		if (used.has(p.jti)) return false;
		used.set(p.jti, (p.exp ?? 0) * 1000);
		return true;
	} catch { return false; }
}
