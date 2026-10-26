import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY ??= 'x';

const run = (mw: any, method: string, path: string, headers: Record<string, string> = {}) => new Promise<{ status?: number; body?: any; headers: Record<string, string>; passed: boolean }>(resolve => {
	const res: any = { headers: {} as Record<string, string>, set(k: string, v: string) { this.headers[k] = v; return this; }, status(c: number) { this.code = c; return this; }, json(b: any) { resolve({ status: this.code, body: b, headers: this.headers, passed: false }); } };
	mw({ method, path, headers } as any, res, () => resolve({ headers: {}, passed: true }));
});
const bearer = (userId: string) => ({ authorization: `Bearer ${jwt.sign({ userId }, 'test-secret')}` });

async function load(t: TestContext, o: { trusted?: { value: boolean; trusted: boolean; stale: boolean }; text?: string; users?: Record<string, { accountType: string; status: string; isBanned?: boolean }>; revoked?: Set<string> }) {
	const state = { trusted: o.trusted ?? { value: true, trusted: true, stale: false }, text: o.text ?? 'نعود قريبًا' };
	t.mock.module('../services/system-settings.service', { namedExports: { systemSettingsService: { getTrusted: async () => state.trusted, get: async () => state.text } } });
	t.mock.module('../config/db', { namedExports: { prisma: { user: { findUnique: async ({ where }: any) => o.users?.[where.id] ?? null } } } });
	t.mock.module('../services/session.service', { namedExports: { sessionService: { isActiveToken: async (tok: string) => !o.revoked?.has((jwt.decode(tok) as any).userId) } } });
	t.mock.module('../config/logger', { namedExports: { logger: { warn: () => undefined, error: () => undefined, info: () => undefined } } });
	const mod = await import(`./maintenance.middleware?m=${Date.now()}-${Math.random()}`);
	return { ...mod, state };
}

test('maintenance ON: only the explicit method+path allowances pass; everything else, including /admin for non-SUPER staff, answers 503 MAINTENANCE', async (t: TestContext) => {
	const { maintenanceMiddleware, MAINTENANCE_ALLOW } = await load(t, { users: { staff: { accountType: 'ADMIN', status: 'ACTIVE' } } });
	for (const [m, p] of [['GET', '/health'], ['GET', '/api/health'], ['GET', '/api'], ['GET', '/api/public/settings'], ['POST', '/api/payments/paypal/webhook'], ['POST', '/payments/paypal/webhook'], ['POST', '/api/client/finance/paypal/order/capture'], ['POST', '/api/auth/login'], ['POST', '/auth/google'], ['POST', '/api/auth/forgot-password'], ['POST', '/api/auth/verify-otp'], ['GET', '/api/notifications'], ['PATCH', '/api/notifications/read-all'], ['PATCH', '/api/notifications/abc/read'], ['GET', '/api/auth/account-status']] as const) assert.equal((await run(maintenanceMiddleware, m, p)).passed, true, `${m} ${p}`);
	assert.ok(MAINTENANCE_ALLOW.every((a: any) => a.purpose.length >= 7), 'every allowance states its purpose');
	for (const [m, p] of [['POST', '/api/client/finance/paypal/order/create'], ['POST', '/api/auth/register'], ['GET', '/api/payments/paypal/webhook'], ['POST', '/api/payments/paypal/other'], ['GET', '/api/admin/users'], ['GET', '/api/projects'], ['POST', '/api/client/wallet'], ['GET', '/api/healthz'], ['GET', '/api/authors'], ['DELETE', '/api/notifications/abc'], ['POST', '/api/auth/onboarding/upload']] as const) {
		const r = await run(maintenanceMiddleware, m, p); assert.equal(r.status, 503, `${m} ${p}`); assert.equal(r.body.code, 'MAINTENANCE'); assert.equal(r.body.message, 'نعود قريبًا'); assert.equal(r.headers['Retry-After'], '60');
	}
	assert.equal((await run(maintenanceMiddleware, 'GET', '/api/admin/users', bearer('staff'))).status, 503, 'an ADMIN-type staff member has no blanket exception');
	assert.equal((await run(maintenanceMiddleware, 'OPTIONS', '/api/projects')).passed, true);
});

test('maintenance ON: an ACTIVE SUPER_ADMIN with a live session reaches the admin console AND the normal platform; a revoked session, a suspended / demoted account or a bad token does not', async (t: TestContext) => {
	const { maintenanceMiddleware, resetMaintenanceCaches } = await load(t, { users: { sa: { accountType: 'SUPER_ADMIN', status: 'ACTIVE' }, saSuspended: { accountType: 'SUPER_ADMIN', status: 'SUSPENDED' }, saBanned: { accountType: 'SUPER_ADMIN', status: 'ACTIVE', isBanned: true }, client: { accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE' }, saRevoked: { accountType: 'SUPER_ADMIN', status: 'ACTIVE' } }, revoked: new Set(['saRevoked']) });
	for (const p of ['/api/admin/users', '/api/projects', '/api/client/wallet', '/api/provider/finance']) assert.equal((await run(maintenanceMiddleware, 'GET', p, bearer('sa'))).passed, true, p);
	resetMaintenanceCaches();
	for (const id of ['saSuspended', 'saBanned', 'client', 'saRevoked', 'unknown']) assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects', bearer(id))).status, 503, id);
	assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects', { authorization: 'Bearer not.a.token' })).status, 503);
	assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects', bearer('sa'))).passed, true);
});

test('maintenance policy under a failing store: the LAST KNOWN GOOD value still decides (a stale ON stays ON); with no trusted value (cold boot) the policy applies - default CLOSED, `open` only by explicit configuration - and the exempt paths always pass', async (t: TestContext) => {
	const { maintenanceMiddleware, state } = await load(t, { trusted: { value: true, trusted: true, stale: true } });
	assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects')).status, 503, 'a read failure never silently cancels an active maintenance');
	state.trusted = { value: false, trusted: true, stale: true }; assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects')).passed, true);
	state.trusted = { value: false, trusted: false, stale: false }; delete process.env.MAINTENANCE_COLD_BOOT_POLICY;
	const c = await run(maintenanceMiddleware, 'GET', '/api/projects'); assert.equal(c.status, 503); assert.match(c.body.message, /تتحقق من حالتها/);
	assert.equal((await run(maintenanceMiddleware, 'GET', '/api/health')).passed, true); assert.equal((await run(maintenanceMiddleware, 'POST', '/api/payments/paypal/webhook')).passed, true);
	process.env.MAINTENANCE_COLD_BOOT_POLICY = 'open'; assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects')).passed, true); delete process.env.MAINTENANCE_COLD_BOOT_POLICY;
});
