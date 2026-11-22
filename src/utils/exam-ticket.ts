import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { prisma } from '../config/db';
import { examSigningSecret } from './exam-signing';

/**
 * A short-lived ticket that proves "this user, from this login session, passed the Safe Exam Browser check on the verified HTTP route a moment ago". It lets a SOCKET flow (the registration
 * setup test, whose transport cannot carry a per-request SEB hash) start in restricted mode without changing how that test runs. Single use, 3 minutes, bound to user + session + scope.
 * Uses a separate signing domain derived from JWT_SECRET. It cannot be used as a login JWT.
 */
export const EXAM_TICKET_TTL_SECONDS = 180;
export type ExamTicketScope = 'SETUP_TEST';
export type ExamReplayScope = ExamTicketScope | 'SEB_JS_CHALLENGE';
export interface TicketUseStore {
  claim(jti: string, userId: string, sessionId: string, scope: ExamReplayScope, expiresAt: Date): Promise<boolean>;
}
// A database unique key is the authority across workers and restarts. Never fall back to process memory.
export const durableExamTicketUses: TicketUseStore = {
  async claim(jti, userId, sessionId, scope, expiresAt) {
    const rows = await prisma.$queryRaw<{ jti: string }[]>`
      INSERT INTO exam_ticket_uses (jti, "userId", "sessionId", scope, "expiresAt")
      VALUES (${jti}, ${userId}, ${sessionId}, ${scope}, ${expiresAt})
      ON CONFLICT (jti) DO NOTHING RETURNING jti`;
    return rows.length === 1;
  }
};

export function issueExamTicket(userId: string, sessionId: string, scope: ExamTicketScope, env: NodeJS.ProcessEnv = process.env): { ticket: string; expiresAt: string } {
	const secret = examSigningSecret(env, 'exam-ticket-v1');
	const jti = randomUUID();
	const ticket = jwt.sign({ purpose: 'EXAM_ENV', scope, userId, sessionId }, secret, { algorithm: 'HS256', expiresIn: EXAM_TICKET_TTL_SECONDS, jwtid: jti });
	return { ticket, expiresAt: new Date(Date.now() + EXAM_TICKET_TTL_SECONDS * 1000).toISOString() };
}

export async function consumeExamTicket(ticket: unknown, expect: { userId: string; sessionId: string | undefined; scope: ExamTicketScope }, env: NodeJS.ProcessEnv = process.env, store: TicketUseStore = durableExamTicketUses): Promise<boolean> {
	if (!env.JWT_SECRET || typeof ticket !== 'string' || !ticket) return false;
	const secret = examSigningSecret(env, 'exam-ticket-v1');
	try {
		const p = jwt.verify(ticket, secret, { algorithms: ['HS256'] }) as { purpose?: string; scope?: string; userId?: string; sessionId?: string; jti?: string; exp?: number };
		if (p.purpose !== 'EXAM_ENV' || p.scope !== expect.scope || p.userId !== expect.userId || !p.sessionId || p.sessionId !== expect.sessionId || !p.jti || !Number.isSafeInteger(p.exp) || p.exp! * 1000 <= Date.now()) return false;
		return await store.claim(p.jti, expect.userId, p.sessionId, expect.scope, new Date(p.exp! * 1000));
	} catch { return false; }
}
