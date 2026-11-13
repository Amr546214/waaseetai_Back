import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { issueExamTicket, consumeExamTicket } from './exam-ticket';

const ENV = { JWT_SECRET: 'unit-secret' } as NodeJS.ProcessEnv;
const who = { userId: 'u1', sessionId: 's1', scope: 'SETUP_TEST' as const };

test('a ticket is valid once, for the same user + login session + scope', () => {
	const { ticket } = issueExamTicket('u1', 's1', 'SETUP_TEST', ENV);
	assert.equal(consumeExamTicket(ticket, { ...who, userId: 'u2' }, ENV), false);
	assert.equal(consumeExamTicket(ticket, { ...who, sessionId: 's2' }, ENV), false);
	assert.equal(consumeExamTicket(ticket, { ...who, sessionId: undefined }, ENV), false);
	assert.equal(consumeExamTicket(ticket, who, ENV), true);
	assert.equal(consumeExamTicket(ticket, who, ENV), false, 'single use');
});
test('forged, expired, wrong-purpose and empty tickets are refused', () => {
	assert.equal(consumeExamTicket('', who, ENV), false);
	assert.equal(consumeExamTicket(undefined, who, ENV), false);
	assert.equal(consumeExamTicket(jwt.sign({ purpose: 'EXAM_ENV', scope: 'SETUP_TEST', userId: 'u1', sessionId: 's1' }, 'other-secret', { jwtid: 'x' }), who, ENV), false);
	assert.equal(consumeExamTicket(jwt.sign({ purpose: 'LOGIN', scope: 'SETUP_TEST', userId: 'u1', sessionId: 's1' }, 'unit-secret', { jwtid: 'y', expiresIn: 60 }), who, ENV), false, 'an access-style token is not a ticket');
	assert.equal(consumeExamTicket(jwt.sign({ purpose: 'EXAM_ENV', scope: 'SETUP_TEST', userId: 'u1', sessionId: 's1' }, 'unit-secret', { jwtid: 'z', expiresIn: -5 }), who, ENV), false);
});
