import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { issueExamTicket, consumeExamTicket } from './exam-ticket';

const ENV = { JWT_SECRET: 'unit-secret' } as NodeJS.ProcessEnv;
const used = new Set<string>();
const store = { claim: async (jti: string) => { if (used.has(jti)) return false; used.add(jti); return true; } };
const who = { userId: 'u1', sessionId: 's1', scope: 'SETUP_TEST' as const };

test('a ticket is valid once, for the same user + login session + scope', async () => {
	const { ticket } = issueExamTicket('u1', 's1', 'SETUP_TEST', ENV);
	assert.equal(await consumeExamTicket(ticket, { ...who, userId: 'u2' }, ENV, store), false);
	assert.equal(await consumeExamTicket(ticket, { ...who, sessionId: 's2' }, ENV, store), false);
	assert.equal(await consumeExamTicket(ticket, { ...who, sessionId: undefined }, ENV, store), false);
	assert.equal(await consumeExamTicket(ticket, who, ENV, store), true);
	assert.equal(await consumeExamTicket(ticket, who, ENV, store), false, 'single use');
});
test('forged, expired, wrong-purpose and empty tickets are refused', async () => {
	assert.equal(await consumeExamTicket('', who, ENV, store), false);
	assert.equal(await consumeExamTicket(undefined, who, ENV, store), false);
	assert.equal(await consumeExamTicket(jwt.sign({ purpose: 'EXAM_ENV', scope: 'SETUP_TEST', userId: 'u1', sessionId: 's1' }, 'other-secret', { jwtid: 'x' }), who, ENV, store), false);
	assert.equal(await consumeExamTicket(jwt.sign({ purpose: 'LOGIN', scope: 'SETUP_TEST', userId: 'u1', sessionId: 's1' }, 'unit-secret', { jwtid: 'y', expiresIn: 60 }), who, ENV, store), false, 'an access-style token is not a ticket');
	assert.equal(await consumeExamTicket(jwt.sign({ purpose: 'EXAM_ENV', scope: 'SETUP_TEST', userId: 'u1', sessionId: 's1' }, 'unit-secret', { jwtid: 'z', expiresIn: -5 }), who, ENV, store), false);
});
