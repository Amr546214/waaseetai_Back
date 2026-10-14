import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// Per-route proof for the unapproved INDIVIDUAL provider: real Express + the REAL routers + real authenticate / role guards / requireApprovedProvider.
// Only the database, the session store and the derived access state (unit-tested elsewhere) are replaced.
process.env.JWT_SECRET = 'gate-secret';
process.env.OPENAI_API_KEY = 'x';
const LOCKED = 'لوحة مقدم الخدمة تفتح بعد اعتماد نموذج الاعتماد من الإدارة';
const state: { approved: boolean } = { approved: false };
const users: Record<string, any> = {
	indiv: { id: 'indiv', email: 'i@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] },
	company: { id: 'company', email: 'c@x.com', accountType: 'PROVIDER_COMPANY', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] },
	actingClient: { id: 'actingClient', email: 'a@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT', 'PROVIDER'] },
};
const modelProxy = () => new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({ user: { findUnique: async ({ where }: any) => users[where.id] ?? null } }, { get: (t: any, k: string) => t[k] ?? modelProxy() });

let srv: Promise<{ url: string }> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }), revokeSession: async () => ({}), revoke: async () => ({}) } } });
		mock.module('../services/provider-access-state.service', { namedExports: {
			DASHBOARD_LOCKED_MESSAGE: LOCKED,
			providerAccessStateService: { get: async () => ({ state: state.approved ? 'APPROVED' : 'PENDING_REVIEW', canAccessDashboard: state.approved, message: '', reason: null, hasSample: true, specialties: [] }) },
		} });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		// the separately mounted provider routers (see app.ts), before /provider
		app.use('/provider/gamification', (await import('./gamification.routes')).default);
		app.use('/provider/logs', (await import('./account-logs.routes')).default);
		app.use('/provider', (await import('./provider.routes')).default);
		app.use('/business-models', (await import('./business-models.routes')).default);
		app.use('/ai-review', (await import('../modules/ai-review/ai-review.routes')).default);
		app.use('/dashboard', (await import('./dashboard/dashboard.routes')).default);
		app.use('/proposals', (await import('./proposal.routes')).default);
		app.use('/projects', (await import('./project.routes')).default);
		app.use('/assistant', (await import('./ai-assistant.routes')).default);
		app.use('/notifications', (await import('./notifications.routes')).default);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		s.unref();
		return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
	})();
	return srv;
}
async function call(as: string, method: string, path: string) {
	const { url } = await server();
	const token = jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' });
	const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({}) });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
const locked = (r: { status: number; body: any }) => r.status === 403 && r.body?.message === LOCKED;

// routes behind the FE pages: business-models/center, new-project/services, projects, offers, explore-requests, statistics, finance, coupons, marketing, gamification, logs, ai-review, dashboard
const GATED: [string, string][] = [
	['GET', '/business-models/my-market-models'], ['POST', '/business-models/publish'], ['POST', '/business-models'],
	['GET', '/provider/services/my-market-models'], ['GET', '/provider/services/pre-data'], ['POST', '/provider/services'], ['PUT', '/provider/services/abc'], ['PATCH', '/provider/services/abc/visibility'],
	['GET', '/provider/projects/active'], ['GET', '/provider/projects/archived'], ['GET', '/provider/projects/abc/progress'], ['POST', '/provider/projects/abc/stages/s1/deliveries'],
	['GET', '/provider/offers'], ['GET', '/provider/offers/abc'], ['POST', '/provider/offers/abc/sign'],
	['GET', '/provider/explore-requests'], ['GET', '/provider/statistics'], ['GET', '/provider/finance/wallet'], ['GET', '/provider/finance/transactions'], ['POST', '/provider/finance/withdrawals'],
	['GET', '/provider/reports'], ['GET', '/provider/coupons'], ['POST', '/provider/coupons'], ['GET', '/provider/marketing/center'], ['GET', '/provider/special-offers'],
	['GET', '/provider/gamification/level-details'], ['GET', '/provider/logs'],
	['POST', '/ai-review/analyze'], ['POST', '/ai-review/suggest-milestones'], ['GET', '/dashboard/stats'],
	['POST', '/projects/abc/proposals'], ['POST', '/proposals/ai-suggest'], ['GET', '/assistant/analyze-project/abc'],
];
const OPEN: [string, string][] = [
	['GET', '/provider/access-state'], ['GET', '/provider/accreditation/samples'], ['GET', '/provider/accreditation/passed-specialties'], ['GET', '/provider/accreditation/eligible-specialties'], ['POST', '/provider/accreditation/submit'],
	['POST', '/provider/profile/setup'], ['GET', '/provider/profile/setup'], ['GET', '/provider/tickets'], ['GET', '/provider/disputes'], ['GET', '/notifications'],
];

for (const [method, path] of GATED) {
	test(`${method} ${path}: 403 «${LOCKED.slice(0, 20)}…» while pending, passes the gate when approved`, async () => {
		state.approved = false;
		assert.ok(locked(await call('indiv', method, path)), 'pending individual must be locked');
		state.approved = true;
		assert.ok(!locked(await call('indiv', method, path)), 'approved individual must pass the gate');
		state.approved = false;
	});
}
for (const [method, path] of OPEN) {
	test(`${method} ${path}: stays reachable for the pending individual provider`, async () => {
		state.approved = false;
		assert.ok(!locked(await call('indiv', method, path)));
	});
}
test('company provider and a provider acting as a client are never blocked by this gate', async () => {
	state.approved = false;
	for (const [method, path] of GATED) {
		assert.ok(!locked(await call('company', method, path)), `company ${path}`);
		assert.ok(!locked(await call('actingClient', method, path)), `acting client ${path}`);
	}
});
