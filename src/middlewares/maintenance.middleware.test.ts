import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x';

const run = (mw: any, method: string, path: string) => new Promise<{ status?: number; body?: any; headers: Record<string, string>; passed: boolean }>(resolve => {
	const res: any = { headers: {} as Record<string, string>, set(k: string, v: string) { this.headers[k] = v; return this; }, status(c: number) { this.code = c; return this; }, json(b: any) { resolve({ status: this.code, body: b, headers: this.headers, passed: false }); } };
	mw({ method, path } as any, res, () => resolve({ headers: {}, passed: true }));
});

test('maintenance middleware: while ON, only the exempt areas pass and everything else answers 503 MAINTENANCE with the configured text; OPTIONS always passes', async (t: TestContext) => {
	let on = true; let text = 'نعود قريبًا';
	t.mock.module('../services/system-settings.service', { namedExports: { systemSettingsService: { get: async (k: string) => (k === 'maintenanceMode' ? on : text) } } });
	const { maintenanceMiddleware, isMaintenanceExempt } = await import(`./maintenance.middleware?m=${Date.now()}`);
	for (const p of ['/health', '/api/health', '/api/auth/login', '/auth/refresh', '/api/public/settings', '/api/admin/users', '/admin/system-settings', '/api/payments/paypal/webhook', '/payments/paypal/webhook', '/api/notifications', '/socket.io/', '/api/docs/', '/', '/api']) {
		assert.equal(isMaintenanceExempt(p), true, p); assert.equal((await run(maintenanceMiddleware, 'POST', p)).passed, true, p);
	}
	for (const p of ['/api/projects', '/projects/1', '/api/client/wallet', '/api/provider/finance', '/api/chat/conversations', '/api/healthz', '/api/authors', '/api/administrators']) {
		const r = await run(maintenanceMiddleware, 'GET', p); assert.equal(r.status, 503, p); assert.equal(r.body.code, 'MAINTENANCE'); assert.equal(r.body.message, 'نعود قريبًا'); assert.equal(r.headers['Retry-After'], '60');
	}
	assert.equal((await run(maintenanceMiddleware, 'OPTIONS', '/api/projects')).passed, true);
	text = ''; assert.match((await run(maintenanceMiddleware, 'GET', '/api/projects')).body.message, /صيانة/);
	on = false; assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects')).passed, true);
});

test('maintenance middleware: if the setting cannot be read the request passes (a settings outage never becomes a platform outage)', async (t: TestContext) => {
	t.mock.module('../services/system-settings.service', { namedExports: { systemSettingsService: { get: async () => { throw new Error('db down'); } } } });
	const { maintenanceMiddleware } = await import(`./maintenance.middleware?m=${Date.now()}b`);
	assert.equal((await run(maintenanceMiddleware, 'GET', '/api/projects')).passed, true);
});
