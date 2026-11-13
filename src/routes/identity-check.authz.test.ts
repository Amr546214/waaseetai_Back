import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// Authorisation matrix of the ID-field-check read endpoints with the REAL authenticate / permission guard (database + session faked, AI never involved).
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'test-key';
const UID = '11111111-1111-4111-8111-111111111111';
const staff = (perms: string[]) => ({ id: 's', status: 'ACTIVE', roleId: 'r', scoped: false, departments: [], overrides: [], role: { id: 'r', name: 'r', permissions: perms } });
const USERS: Record<string, any> = {
	reviewer: { id: 'u-rev', email: 'r@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	otherPerm: { id: 'u-oth', email: 'o@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	specialtiesOnly: { id: 'u-spec', email: 'sp@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	noRole: { id: 'u-none', email: 'n@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	superAdmin: { id: 'u-sa', email: 's@x.com', accountType: 'SUPER_ADMIN', status: 'ACTIVE', activeRole: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'] },
	client: { id: 'u-c', email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	provider: { id: 'u-p', email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['PROVIDER'] }
};
const STAFF: Record<string, any> = { 'u-rev': staff(['identity.review']), 'u-oth': staff(['finance.view']), 'u-spec': staff(['specialties.approve']) };
const byId = new Map(Object.values(USERS).map(u => [u.id, u]));
const tokenFor = (k: string) => jwt.sign({ userId: USERS[k].id }, 'test-secret');
const calls: string[] = [];
const emptyModel: any = new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({
	user: { findUnique: async ({ where }: any) => byId.get(where.id) ?? null },
	adminStaff: { findUnique: async ({ where }: any) => STAFF[where.userId] ?? null },
	identityFieldCheck: { findFirst: async () => { calls.push('check'); return { id: 'c', status: 'DONE', imageVersion: 1, imageRefDigest: 'abc'.repeat(21).slice(0, 64), stateReason: null, createdAt: new Date(), startedAt: new Date(), finishedAt: new Date(), modelName: 'm', modelVersion: '1', fieldResults: { fullName: { status: 'MATCH' }, birthDate: { status: 'MISMATCH' }, nationalId: { status: 'COULD_NOT_VERIFY', reason: 'LOW_CONFIDENCE' } } }; } },
	providerProfile: { findUnique: async ({ where }: any) => where.userId === UID ? { frontIdUrl: null } : null },
	clientProfile: { findUnique: async () => null }
}, { get: (t: any, k: string) => t[k] ?? emptyModel });
mock.module('../config/db', { namedExports: { prisma } });
mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 'sess' }) } } });

async function call(url: string, token?: string) {
	const express = (await import('express')).default;
	const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const admin = (await import('./admin-onboarding.routes')).default;
	const owner = (await import('./identity-check.routes')).default;
	const app = express(); app.use(express.json()); app.use('/api/admin/onboarding', admin); app.use('/api/identity-check', owner); app.use(globalErrorHandler as any);
	const server = http.createServer(app);
	await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	try {
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, { headers: { connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
		return { status: res.status, body: await res.json().catch(() => null) as any, cache: res.headers.get('cache-control') };
	} finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
const A = `/api/admin/onboarding/identity-check/${UID}?party=PROVIDER`;

test('admin read: only an admin holding identity.review (or a SUPER_ADMIN) is let through; everyone else 401/403', async () => {
	assert.equal((await call(A)).status, 401);
	for (const who of ['client', 'provider', 'noRole', 'otherPerm', 'specialtiesOnly']) { calls.length = 0; assert.equal((await call(A, tokenFor(who))).status, 403, who); assert.equal(calls.length, 0, `${who}: the check table is never read`); }
	for (const who of ['reviewer', 'superAdmin']) { const r = await call(A, tokenFor(who)); assert.equal(r.status, 200, who); assert.equal(r.cache, 'no-store'); }
});

test('admin read: response shape, advisory markers, bad input 400, unknown profile 404', async () => {
	const r = await call(A, tokenFor('reviewer'));
	assert.equal(r.body.data.manualReviewRequired, true); assert.equal(r.body.data.advisory, true);
	assert.deepEqual(r.body.data.notExamined, { faceMatch: 'NOT_EXAMINED', liveness: 'NOT_EXAMINED', documentAuthenticity: 'NOT_EXAMINED' });
	assert.equal((await call(`/api/admin/onboarding/identity-check/${UID}`, tokenFor('reviewer'))).status, 400);
	assert.equal((await call(`/api/admin/onboarding/identity-check/${UID}?party=ADMIN`, tokenFor('reviewer'))).status, 400);
	assert.equal((await call(`/api/admin/onboarding/identity-check/not-a-uuid?party=PROVIDER`, tokenFor('reviewer'))).status, 400);
	assert.equal((await call(`/api/admin/onboarding/identity-check/22222222-2222-4222-8222-222222222222?party=PROVIDER`, tokenFor('reviewer'))).status, 404);
});

test('owner endpoint: authenticated users get ONLY {state}; no token 401; the user id cannot be chosen; no field data, ever', async () => {
	assert.equal((await call('/api/identity-check/me?party=PROVIDER')).status, 401);
	for (const who of ['client', 'provider', 'reviewer']) {
		const r = await call('/api/identity-check/me?party=PROVIDER', tokenFor(who));
		assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.body.data), ['state']); assert.ok(['IN_REVIEW', 'NONE'].includes(r.body.data.state));
		assert.ok(!JSON.stringify(r.body).match(/MATCH|MISMATCH|COULD_NOT_VERIFY|fields|model|digest/));
	}
	const r = await call(`/api/identity-check/me?party=PROVIDER&userId=${UID}`, tokenFor('client'));
	assert.deepEqual(r.body.data, { state: 'NONE' });
	assert.equal((await call('/api/identity-check/me', tokenFor('client'))).status, 400);
});

test('the owner route is not under /admin and the admin route is guarded (structural)', async () => {
	const admin: any = (await import('./admin-onboarding.routes')).default;
	const guarded = admin.stack.some((l: any) => !l.route && (l.handle as any).adminPermissions?.includes('identity.review'));
	assert.ok(guarded, 'router-level identity.review guard present before the identity-check route');
	const idx = admin.stack.findIndex((l: any) => l.route?.path === '/identity-check/:userId');
	const guardIdx = admin.stack.findIndex((l: any) => !l.route && (l.handle as any).adminPermissions?.includes('identity.review'));
	assert.ok(idx > guardIdx && guardIdx >= 0);
});
