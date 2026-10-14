import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// Route table: EVERY provider-prefixed operational route x {client, marketer, admin, no token} => 403/401, and the provider (individual / company) passes the role gate.
// Real Express + the REAL routers + real authenticate / role guards. Only the database, the session store and the derived access state are replaced.
process.env.JWT_SECRET = 'role-gate-secret';
process.env.OPENAI_API_KEY = 'x';
const users: Record<string, any> = {
	client: { id: 'client', email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	marketer: { id: 'marketer', email: 'm@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE'] },
	admin: { id: 'admin', email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	// holds PROVIDER in roles but ACTS as a client: operational provider routes must refuse (activeRole decides)
	actingClient: { id: 'actingClient', email: 'ac@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT', 'PROVIDER'] },
	indiv: { id: 'indiv', email: 'i@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] },
	company: { id: 'company', email: 'co@x.com', accountType: 'PROVIDER_COMPANY', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] },
};
const modelProxy = () => new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({ user: { findUnique: async ({ where }: any) => users[where.id] ?? null } }, { get: (t: any, k: string) => t[k] ?? modelProxy() });

let srv: Promise<{ url: string; routers: Record<string, any> }> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }), revokeSession: async () => ({}), revoke: async () => ({}) } } });
		mock.module('../services/provider-access-state.service', { namedExports: {
			DASHBOARD_LOCKED_MESSAGE: 'locked',
			providerAccessStateService: { get: async () => ({ state: 'APPROVED', canAccessDashboard: true, message: '', reason: null, hasSample: true, specialties: [] }) },
		} });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const provider = (await import('./provider.routes')).default;
		const app = express();
		app.use(express.json());
		app.use('/provider/gamification', (await import('./gamification.routes')).default);
		app.use('/provider/logs', (await import('./account-logs.routes')).default);
		app.use('/provider', provider);
		app.use('/business-models', (await import('./business-models.routes')).default);
		app.use('/ai-review', (await import('../modules/ai-review/ai-review.routes')).default);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		s.unref();
		return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, routers: { provider } };
	})();
	return srv;
}
async function call(as: string | null, method: string, path: string) {
	const { url } = await server();
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	const res = await fetch(`${url}${path.replace(/:\w+/g, 'abc')}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify({}) });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

// provider-operational routes (templates). Onboarding / identity routes that deliberately stay open to any authenticated role (profile/sessions, profile/password, the public profile) are not listed.
export const PROVIDER_OPERATIONAL: [string, string][] = [
	['GET', '/provider/access-state'], ['GET', '/provider/reports'], ['GET', '/provider/statistics'],
	['GET', '/provider/services/my-market-models'], ['GET', '/provider/services/pre-data'], ['POST', '/provider/services/upload-gallery'], ['PATCH', '/provider/services/:id/visibility'], ['GET', '/provider/services/:id'], ['PUT', '/provider/services/:id'], ['POST', '/provider/services'],
	['GET', '/provider/company/team'], ['POST', '/provider/company/team'], ['GET', '/provider/company/team/:id'], ['PUT', '/provider/company/team/:id'], ['DELETE', '/provider/company/team/:id'], ['GET', '/provider/company/deliveries'],
	['POST', '/provider/coupons'], ['GET', '/provider/coupons'], ['GET', '/provider/coupons/:id/stats'], ['GET', '/provider/coupons/:id'], ['PUT', '/provider/coupons/:id'], ['DELETE', '/provider/coupons/:id'], ['PATCH', '/provider/coupons/:id/approval'],
	['POST', '/provider/special-offers'], ['GET', '/provider/special-offers'], ['GET', '/provider/special-offers/summary'], ['GET', '/provider/special-offers/:id/stats'], ['GET', '/provider/special-offers/:id'], ['PUT', '/provider/special-offers/:id'], ['DELETE', '/provider/special-offers/:id'], ['PATCH', '/provider/special-offers/:id/approval'],
	['GET', '/provider/marketing/center'], ['PATCH', '/provider/marketing/spend-cap'],
	['GET', '/provider/projects/:id/amendments'], ['POST', '/provider/projects/:id/amendments'], ['POST', '/provider/amendments/:id/respond'], ['POST', '/provider/amendments/:id/cancel'],
	['POST', '/provider/projects/:id/stages/:stageId/deliveries/files'], ['POST', '/provider/projects/:id/stages/:stageId/deliveries'], ['POST', '/provider/projects/:id/stages/:stageId/ai-review'], ['POST', '/provider/projects/:id/health'],
	['GET', '/provider/projects/active'], ['GET', '/provider/projects/archived'], ['GET', '/provider/projects/:id/progress'],
	['GET', '/provider/finance/wallet'], ['GET', '/provider/finance/transactions'], ['GET', '/provider/finance/invoices'], ['GET', '/provider/finance/invoices/:id'], ['GET', '/provider/finance/sales'], ['POST', '/provider/finance/withdrawals'], ['GET', '/provider/finance/withdrawals'],
	['GET', '/provider/offers'], ['GET', '/provider/offers/:id'], ['GET', '/provider/offers/:id/negotiation'], ['GET', '/provider/projects/:id/negotiation'], ['POST', '/provider/offers/:id/withdraw'], ['POST', '/provider/offers/:id/counter'], ['POST', '/provider/offers/:id/negotiation/reject'], ['POST', '/provider/offers/:id/sign'],
	['GET', '/provider/explore-requests'], ['POST', '/provider/explore-requests/:id/toggle-save'],
	['POST', '/provider/requests/:id/disputes'], ['POST', '/provider/requests/:id/rate'], ['POST', '/provider/requests/:id/cancel'], ['GET', '/provider/disputes'], ['GET', '/provider/disputes/:id'],
	['POST', '/provider/tickets'], ['GET', '/provider/tickets'], ['GET', '/provider/tickets/:id'], ['POST', '/provider/tickets/:id/reply'], ['POST', '/provider/tickets/:id/close'],
	['GET', '/provider/accreditation/eligible-specialties'], ['GET', '/provider/accreditation/passed-specialties'], ['GET', '/provider/accreditation/samples'], ['POST', '/provider/accreditation/submit'],
	['GET', '/provider/gamification/level-details'], ['GET', '/provider/logs'], ['GET', '/provider/logs/:id'],
	['GET', '/business-models/my-market-models'], ['POST', '/business-models/publish'], ['POST', '/business-models'],
	['POST', '/ai-review/suggest-milestones'], ['POST', '/ai-review/analyze'],
];
// company-only routes: an individual provider is refused as well (strict accountType)
const COMPANY_ONLY = new Set(['PATCH /provider/coupons/:id/approval', 'PATCH /provider/special-offers/:id/approval', 'PATCH /provider/marketing/spend-cap', 'GET /provider/company/team', 'POST /provider/company/team', 'GET /provider/company/team/:id', 'PUT /provider/company/team/:id', 'DELETE /provider/company/team/:id']);

const roleRefused = (r: { status: number }) => r.status === 403;
for (const [method, path] of PROVIDER_OPERATIONAL) {
	test(`${method} ${path}: client / marketer / admin / provider-acting-as-client => 403, no token => 401`, async () => {
		for (const who of ['client', 'marketer', 'admin', 'actingClient']) assert.ok(roleRefused(await call(who, method, path)), `${who} must get 403`);
		assert.equal((await call(null, method, path)).status, 401);
	});
	test(`${method} ${path}: the acting provider passes the role gate`, async () => {
		const company = await call('company', method, path);
		assert.ok(![401, 403].includes(company.status), `company provider blocked (${company.status})`);
		if (!COMPANY_ONLY.has(`${method} ${path}`)) {
			const indiv = await call('indiv', method, path);
			assert.ok(![401, 403].includes(indiv.status), `individual provider blocked (${indiv.status})`);
		}
	});
}

test('coverage: every direct route declared on provider.routes is in the table (a new route cannot slip through ungated)', async () => {
	const { routers } = await server();
	const declared: string[] = [];
	for (const layer of routers.provider.stack) {
		if (!layer.route) continue;
		for (const m of Object.keys(layer.route.methods)) declared.push(`${m.toUpperCase()} /provider${layer.route.path}`);
	}
	const norm = (x: string) => x.replace(/:\w+/g, ':x');
	const table = new Set(PROVIDER_OPERATIONAL.map(([m, p]) => norm(`${m} ${p}`)));
	assert.ok(declared.length > 30);
	const missing = declared.filter(d => !table.has(norm(d)));
	assert.deepEqual(missing, []);
});
