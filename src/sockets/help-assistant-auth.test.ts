import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// Per-request auth for the dashboard Help Assistant / Avatar. prisma and the
// session service are mocked; JWTs are signed with a synthetic test secret.

const TEST_SECRET = ['help', 'auth', 'test', 'secret'].join('-');

async function load(t: TestContext, opts: { user?: any; session?: any } = {}) {
	const prev = process.env.JWT_SECRET;
	process.env.JWT_SECRET = TEST_SECRET;
	t.after(() => { process.env.JWT_SECRET = prev; });
	const sessionCalls: any[] = [];
	t.mock.module('../config/db', {
		namedExports: { prisma: { user: { findUnique: async () => (opts.user === undefined ? { accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', isBanned: false } : opts.user) } } },
	});
	t.mock.module('../services/session.service', {
		namedExports: { sessionService: { validateOrRegister: async (...args: any[]) => { sessionCalls.push(args); return opts.session === undefined ? { id: 's1' } : opts.session; } } },
	});
	const mod = await import(`./help-assistant-auth.ts?fixture=${Date.now()}-${Math.random()}`);
	return { resolve: mod.resolveHelpAssistantUser as (s: any) => Promise<any>, mapRole: mod.mapHelpAssistantRole as (a: any, b: any) => any, sessionCalls };
}

const socketWith = (userId: string | undefined, token: string | null) => ({ userId, handshake: { auth: token ? { token } : {}, headers: {}, address: '127.0.0.1' } });

test('resolveHelpAssistantUser: a guest socket (no verified userId / no token) is UNAUTHENTICATED', async (t) => {
	const { resolve } = await load(t);
	assert.deepEqual(await resolve(socketWith(undefined, null)), { ok: false, reason: 'UNAUTHENTICATED' });
	const token = jwt.sign({ userId: 'u1' }, TEST_SECRET);
	assert.deepEqual(await resolve(socketWith(undefined, token)), { ok: false, reason: 'UNAUTHENTICATED' });
});

test('resolveHelpAssistantUser: an expired or foreign token, or a token for another user, is UNAUTHENTICATED', async (t) => {
	const { resolve } = await load(t);
	const expired = jwt.sign({ userId: 'u1', exp: Math.floor(Date.now() / 1000) - 60 }, TEST_SECRET);
	assert.equal((await resolve(socketWith('u1', expired))).ok, false);
	const forged = jwt.sign({ userId: 'u1' }, 'another-secret');
	assert.equal((await resolve(socketWith('u1', forged))).ok, false);
	const other = jwt.sign({ userId: 'u2' }, TEST_SECRET);
	assert.equal((await resolve(socketWith('u1', other))).ok, false);
});

test('resolveHelpAssistantUser: a revoked session is UNAUTHENTICATED', async (t) => {
	const { resolve } = await load(t, { session: null });
	const token = jwt.sign({ userId: 'u1' }, TEST_SECRET);
	assert.deepEqual(await resolve(socketWith('u1', token)), { ok: false, reason: 'UNAUTHENTICATED' });
});

test('resolveHelpAssistantUser: suspended, pending or banned accounts are FORBIDDEN', async (t) => {
	for (const user of [
		{ accountType: 'CLIENT_INDIVIDUAL', status: 'SUSPENDED', activeRole: 'CLIENT', isBanned: false },
		{ accountType: 'CLIENT_INDIVIDUAL', status: 'SUSPENDED_REVIEW', activeRole: 'CLIENT', isBanned: false },
		{ accountType: 'CLIENT_INDIVIDUAL', status: 'PENDING_VERIFICATION', activeRole: 'CLIENT', isBanned: false },
		{ accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', isBanned: true },
	]) {
		const { resolve } = await load(t, { user });
		const token = jwt.sign({ userId: 'u1' }, TEST_SECRET);
		assert.deepEqual(await resolve(socketWith('u1', token)), { ok: false, reason: 'FORBIDDEN' });
		t.mock.restoreAll();
	}
});

test('resolveHelpAssistantUser: an active authenticated user gets a role derived from the DB, and the session is validated', async (t) => {
	const { resolve, sessionCalls } = await load(t, { user: { accountType: 'PROVIDER_COMPANY', status: 'ACTIVE', activeRole: 'PROVIDER', isBanned: false } });
	const token = jwt.sign({ userId: 'u9' }, TEST_SECRET);
	assert.deepEqual(await resolve(socketWith('u9', token)), { ok: true, userId: 'u9', role: 'provider' });
	assert.equal(sessionCalls.length, 1);
	assert.equal(sessionCalls[0][0], 'u9');
});

test('mapHelpAssistantRole: activeRole wins; account type is the fallback; unknown is rejected', async (t) => {
	const { mapRole } = await load(t);
	assert.equal(mapRole('CLIENT', 'PROVIDER_INDIVIDUAL'), 'client');
	assert.equal(mapRole('AFFILIATE', 'CLIENT_INDIVIDUAL'), 'marketer');
	assert.equal(mapRole('SUPER_ADMIN', 'SUPER_ADMIN'), 'admin');
	// schema default activeRole=CLIENT must not demote an admin account
	assert.equal(mapRole('CLIENT', 'SUPER_ADMIN'), 'admin');
	assert.equal(mapRole('CLIENT', 'ADMIN'), 'admin');
	assert.equal(mapRole(null, 'MARKETING_BROKER'), 'marketer');
	assert.equal(mapRole(null, 'EMPLOYEE'), null);
});
