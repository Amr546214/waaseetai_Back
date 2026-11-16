import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// The account activity log is for EVERY role: a client, a marketer and a provider (even one not yet approved) each read their OWN log; no token = 401. Real Express, the real router,
// real authenticate; only the database and the session store are replaced.
process.env.JWT_SECRET = 'logs-any-role-secret';
process.env.OPENAI_API_KEY = 'x';
const users: Record<string, any> = {
	client: { id: 'client', email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	marketer: { id: 'marketer', email: 'm@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE'] },
	pendingProvider: { id: 'pendingProvider', email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['PROVIDER'] },
	suspended: { id: 'suspended', email: 's@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'SUSPENDED', activeRole: 'CLIENT', roles: ['CLIENT'] },
};
const queried: any[] = [];
const modelProxy = () => new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({
	user: { findUnique: async ({ where }: any) => users[where.id] ?? null },
	accountAuditLog: {
		findMany: async ({ where }: any) => { queried.push(where); return [{ id: `log-${where.userId}`, userId: where.userId, category: 'SYSTEM_AUDIT', title: 'حدث', status: 'COMPLETED', createdAt: new Date('2026-11-15T10:00:00Z'), occurredAt: new Date('2026-11-15T10:00:00Z') }]; },
		count: async () => 1, groupBy: async () => [],
		findFirst: async ({ where }: any) => (where.userId === 'client' ? { id: where.id, userId: 'client', category: 'SYSTEM_AUDIT', title: 'حدث', status: 'COMPLETED', createdAt: new Date() } : null),
	},
	$transaction: async (ops: Promise<any>[]) => Promise.all(ops),
}, { get: (t: any, k: string) => t[k] ?? modelProxy() });

let srv: Promise<string> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }), revokeSession: async () => ({}), revoke: async () => ({}) } } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		app.use('/account/logs', (await import('./account-logs.any-role.routes')).default);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		s.unref();
		return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
	})();
	return srv;
}
async function call(as: string | null, path = '/account/logs') {
	const url = await server();
	const headers: Record<string, string> = {};
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	const res = await fetch(`${url}${path}`, { headers });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('client, marketer and an unapproved provider each get 200 with THEIR OWN entries only', async () => {
	for (const who of ['client', 'marketer', 'pendingProvider']) {
		queried.length = 0;
		const r = await call(who);
		assert.equal(r.status, 200, who);
		assert.equal(r.body.success, true);
		assert.deepEqual(queried.map(w => w.userId), [who], `${who}: the query is scoped to the caller`);
		assert.equal(r.body.data.items[0].id, `log-${who}`);
	}
});

test('no token is 401, a suspended account is refused, and nobody can read another account\'s single entry', async () => {
	assert.equal((await call(null)).status, 401);
	assert.ok([401, 403].includes((await call('suspended')).status));
	assert.equal((await call('client', '/account/logs/abc')).status, 200);
	assert.equal((await call('marketer', '/account/logs/abc')).status, 404, 'an entry that is not the caller\'s does not exist for them');
});
