import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// The two SUPER_ADMIN-only admin routes: DELETE /admin/users/:id and POST /admin/disputes/:id/resolve-financial.
// REAL authenticate / requireActiveUser / authorize middleware; the controllers are replaced by counters, so "refused before any side effect" is proven by
// the handler never running. ISOLATED: no database, no money, nothing real is called.
process.env.JWT_SECRET = 'test-secret';
process.env.OPENAI_API_KEY = 'test-key';

const USERS: Record<string, any> = {
	admin: { id: 'u-admin', email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	adminActingClient: { id: 'u-admin2', email: 'a2@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['ADMIN', 'CLIENT'] },
	superAdmin: { id: 'u-sa', email: 's@x.com', accountType: 'SUPER_ADMIN', status: 'ACTIVE', activeRole: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'] },
	client: { id: 'u-c', email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	provider: { id: 'u-p', email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['PROVIDER', 'CLIENT'] },
	affiliate: { id: 'u-m', email: 'm@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE', 'CLIENT'] },
};
const tokenFor = (key: string) => jwt.sign({ userId: USERS[key].id }, 'test-secret');
const byId = new Map(Object.values(USERS).map(u => [u.id, u]));
const emptyModel: any = new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({ user: { findUnique: async ({ where }: any) => byId.get(where.id) ?? null } }, { get: (t: any, k: string) => t[k] ?? emptyModel });
mock.module('../config/db', { namedExports: { prisma } });
mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 'sess' }) } } });

const calls = { deleteUser: 0, resolveFinancial: 0 };
const ok = (key: keyof typeof calls) => (_req: any, res: any) => { calls[key]++; res.status(200).json({ success: true }); };
const passthrough = (_req: any, _res: any, next: any) => next();
mock.module('../controllers/admin-users.controller', { namedExports: { AdminUsersController: new Proxy({ deleteUser: ok('deleteUser') }, { get: (t: any, k: string) => t[k] ?? passthrough }) } });
mock.module('../controllers/dispute.controller', {
	namedExports: { resolveDisputeFinancial: ok('resolveFinancial'), addAdminDisputeNote: passthrough, assignAdminDispute: passthrough, setAdminDisputeStatus: passthrough, listDisputes: passthrough, getDispute: passthrough, resolveDispute: passthrough, getDisputeAiSummary: passthrough, listMyDisputes: passthrough, getMyDispute: passthrough, openClientDispute: passthrough, openProviderDispute: passthrough, cancelProviderRequest: passthrough },
});

async function request(handler: any, method: string, url: string, token?: string) {
	const server = http.createServer(handler);
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
	try {
		const port = (server.address() as AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
		await res.arrayBuffer();
		return res.status;
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

async function appFor(prefix: string, file: string) {
	const express = (await import('express')).default;
	const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const router = ((await import(file)) as any).default;
	const app = express();
	app.use(express.json());
	app.use(prefix, router);
	app.use(globalErrorHandler as any);
	return app;
}

const ROUTES = [
	{ name: 'DELETE /admin/users/:id', counter: 'deleteUser' as const, method: 'DELETE', url: '/admin/users/x', build: () => appFor('/admin/users', './admin-users.routes.ts') },
	{ name: 'POST /admin/disputes/:id/resolve-financial', counter: 'resolveFinancial' as const, method: 'POST', url: '/admin/disputes/x/resolve-financial', build: () => appFor('/admin/disputes', './admin-disputes.routes.ts') },
];

for (const r of ROUTES) {
	test(`${r.name}: no token 401; client / provider / affiliate / ADMIN (also an ADMIN acting as client) get 403 and the handler never runs`, async () => {
		const app = await r.build();
		calls[r.counter] = 0;
		assert.equal(await request(app, r.method, r.url), 401);
		for (const who of ['client', 'provider', 'affiliate', 'admin', 'adminActingClient']) {
			assert.equal(await request(app, r.method, r.url, tokenFor(who)), 403, `${who} must be refused`);
		}
		assert.equal(calls[r.counter], 0, 'no side effect for a refused caller');
	});

	test(`${r.name}: SUPER_ADMIN passes the authorization check and reaches the handler (isolated, handler is a counter)`, async () => {
		const app = await r.build();
		calls[r.counter] = 0;
		assert.equal(await request(app, r.method, r.url, tokenFor('superAdmin')), 200);
		assert.equal(calls[r.counter], 1);
	});
}
