import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// #35 — requireActiveUser on account-management, chat, notifications (state changes), proposal and marketer-overview. SUSPENDED_REVIEW is blocked
// like SUSPENDED. Exceptions that stay open for every authenticated account: GET /notifications*, logout, and GET /auth/account-status.
// Real Express + real authenticate / requireActiveUser / authorize; only the database and the session store are replaced.
process.env.JWT_SECRET = 'gating-secret';
process.env.OPENAI_API_KEY = 'x';

const STATUSES = ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'SUSPENDED_REVIEW'] as const;
const user = (status: string, accountType = 'MARKETING_BROKER') => ({ id: `u-${status}`, email: `${status}@x.com`, accountType, status, activeRole: accountType === 'MARKETING_BROKER' ? 'AFFILIATE' : 'PROVIDER', roles: [accountType === 'MARKETING_BROKER' ? 'AFFILIATE' : 'PROVIDER'] });
const users: Record<string, any> = Object.fromEntries(STATUSES.map(s => [`u-${s}`, user(s)]));
const providers: Record<string, any> = Object.fromEntries(STATUSES.map(s => [`p-${s}`, { ...user(s, 'PROVIDER_INDIVIDUAL'), id: `p-${s}` }]));
const everyone = { ...users, ...providers };

const modelProxy = () => new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({ user: { findUnique: async ({ where }: any) => everyone[where.id] ?? null } }, { get: (t: any, k: string) => t[k] ?? modelProxy() });

let srv: Promise<{ url: string; close: () => void }> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }), revokeSession: async () => ({}), revoke: async () => ({}) } } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		app.use('/notifications', (await import('./notifications.routes')).default);
		app.use('/chat', (await import('./chat.routes')).default);
		app.use('/account-management', (await import('./account-management.routes')).default);
		app.use('/proposals', (await import('./proposal.routes')).default);
		app.use('/marketer-overview', (await import('./marketer-overview.routes')).default);
		app.use('/auth', (await import('./auth/auth.routes')).default);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
	})();
	return srv;
}
async function call(as: string, method: string, path: string, body?: any) {
	const { url } = await server();
	const token = jwt.sign({ userId: as, accountType: everyone[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' });
	const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
const BLOCKED: Record<string, RegExp> = { PENDING_VERIFICATION: /تفعيل حسابك/, SUSPENDED: /معطل/, SUSPENDED_REVIEW: /مراجعة الإيقاف/ };
const isGateBlock = (r: { status: number; body: any }) => r.status === 403 && /تفعيل حسابك|معطل|مراجعة الإيقاف/.test(String(r.body?.message));

// [method, path, who] — `who`: 'u' marketer accounts, 'p' provider accounts
const GATED: [string, string, 'u' | 'p', any?][] = [
	['GET', '/account-management/available-account-types', 'u'],
	['POST', '/account-management/switch-active-role', 'u', { role: 'AFFILIATE' }],
	['POST', '/account-management/add-account-type', 'u', { accountType: 'CLIENT_INDIVIDUAL' }],
	['GET', '/chat/conversations', 'u'],
	['GET', '/chat/conversations/abc/messages', 'u'],
	['POST', '/chat/conversations/initiate', 'u', {}],
	['POST', '/chat/upload', 'u'],
	['PATCH', '/notifications/read-all', 'u'],
	['PATCH', '/notifications/abc/read', 'u'],
	['PATCH', '/notifications/preferences', 'u', {}],
	['POST', '/proposals/ai-suggest', 'p', {}],
	['GET', '/marketer-overview/summary', 'u'],
	['GET', '/marketer-overview/referrals', 'u'],
	['GET', '/marketer-overview/ref-links', 'u'],
];

for (const status of ['PENDING_VERIFICATION', 'SUSPENDED', 'SUSPENDED_REVIEW'] as const) {
	test(`${status}: every gated route answers 403 with the account-state message and never reaches its handler`, async () => {
		for (const [method, path, who, body] of GATED) {
			const r = await call(`${who === 'p' ? 'p' : 'u'}-${status}`, method, path, body);
			assert.equal(r.status, 403, `${method} ${path}`);
			assert.match(String(r.body.message), BLOCKED[status], `${method} ${path}`);
		}
	});
}

test('ACTIVE: the gate lets every route through (a handler may answer anything else, never the account-state 403)', async () => {
	for (const [method, path, who, body] of GATED) {
		const r = await call(`${who === 'p' ? 'p' : 'u'}-ACTIVE`, method, path, body);
		assert.equal(isGateBlock(r), false, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
	}
});

for (const status of STATUSES) {
	test(`${status}: the exceptions stay open — GET /notifications, GET /notifications/preferences, GET /auth/account-status, POST /auth/logout`, async () => {
		for (const [method, path] of [['GET', '/notifications'], ['GET', '/notifications/preferences'], ['POST', '/auth/logout']] as const) {
			const r = await call(`u-${status}`, method, path);
			assert.equal(isGateBlock(r), false, `${method} ${path} -> ${r.status}`);
		}
		const s = await call(`u-${status}`, 'GET', '/auth/account-status');
		assert.equal(s.status, 200);
		assert.equal(s.body.data.status, status);
		assert.match(s.body.data.message, /[؀-ۿ]/);
		assert.deepEqual(Object.keys(s.body.data).sort(), ['message', 'status']);
	});
}

test('unauthenticated requests are still 401 everywhere (the gate does not replace authenticate)', async () => {
	const { url } = await server();
	for (const p of ['/notifications', '/chat/conversations', '/account-management/available-account-types', '/marketer-overview/summary', '/auth/account-status']) {
		assert.equal((await fetch(`${url}${p}`)).status, 401, p);
	}
});

test('a marketer with a SUSPENDED_REVIEW token on the already gated routes of other modules is blocked too (middleware-level change)', async () => {
	const { requireActiveUser } = await import('../middlewares/auth.middleware');
	let err: any;
	requireActiveUser({ user: { status: 'SUSPENDED_REVIEW' } } as any, {} as any, (e?: any) => { err = e; });
	assert.equal(err?.statusCode, 403);
	err = undefined;
	requireActiveUser({ user: { status: 'ACTIVE' } } as any, {} as any, (e?: any) => { err = e; });
	assert.equal(err, undefined);
});

test.after(async () => { (await server()).close(); });
