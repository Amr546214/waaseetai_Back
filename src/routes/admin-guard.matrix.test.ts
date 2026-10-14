import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// Route-level admin guard matrix with the REAL authenticate / requireActiveUser / authorize middleware (only the database and the session store are
// faked). Every router mounted under /admin in app.ts is loaded from the mount table itself, so a new /admin mount without the admin guard fails here.
process.env.JWT_SECRET = 'test-secret';
process.env.OPENAI_API_KEY = 'test-key';

const USERS: Record<string, any> = {
	admin: { id: 'u-admin', email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	superAdmin: { id: 'u-sa', email: 's@x.com', accountType: 'SUPER_ADMIN', status: 'ACTIVE', activeRole: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'] },
	// a real super admin keeps CLIENT as its default active role and must NOT be locked out
	superAdminActingClient: { id: 'u-sa2', email: 's2@x.com', accountType: 'SUPER_ADMIN', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['SUPER_ADMIN', 'CLIENT'] },
	client: { id: 'u-c', email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	provider: { id: 'u-p', email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['PROVIDER', 'CLIENT'] },
	affiliate: { id: 'u-m', email: 'm@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE', 'CLIENT'] }
};
const tokenFor = (key: string) => jwt.sign({ userId: USERS[key].id }, 'test-secret');
const byId = new Map(Object.values(USERS).map(u => [u.id, u]));

// any other prisma call resolves to an empty-ish value, so an ALLOWED request just ends in a handler result (never 401/403)
const emptyModel: any = new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({ user: { findUnique: async ({ where }: any) => byId.get(where.id) ?? null } }, { get: (t: any, k: string) => t[k] ?? emptyModel });
mock.module('../config/db', { namedExports: { prisma } });
mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 'sess' }) } } });

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8');

/** `import xRouter from './routes/x'` / `import { a, b } from './routes/x'` -> identifier -> file */
function importedRouters() {
	const out = new Map<string, { file: string; name: string }>();
	for (const m of appSource.matchAll(/import\s+(\w+)\s+from\s+'(\.\/routes\/[^']+)'/g)) out.set(m[1], { file: m[2], name: 'default' });
	for (const m of appSource.matchAll(/import\s+\{([^}]+)\}\s+from\s+'(\.\/routes\/[^']+)'/g)) for (const n of m[1].split(',').map(s => s.trim()).filter(Boolean)) out.set(n, { file: m[2], name: n });
	return out;
}
const adminMounts = [...appSource.matchAll(/mountAppRoute\('\/api\/admin\/([\w-]+)',\s*(\w+)\)/g)].map(m => ({ prefix: m[1], ident: m[2] }));

test('app.ts mounts the expected admin routers (table is read from the source, not hard-coded)', () => {
	assert.ok(adminMounts.length >= 12, `found ${adminMounts.length} admin mounts`);
	for (const prefix of ['users', 'dashboard', 'requests', 'offers', 'onboarding', 'accreditation', 'specialties', 'security']) assert.ok(adminMounts.some(m => m.prefix === prefix), `/admin/${prefix} mounted`);
	// every admin mount is also served without the /api prefix
	for (const m of adminMounts) assert.match(appSource, new RegExp(`mountAppRoute\\('/admin/${m.prefix}',\\s*${m.ident}\\)`));
});

async function request(handler: any, method: string, url: string, token?: string) {
	const server = http.createServer(handler);
	await new Promise<void>(r => server.listen(0, r));
	try {
		const port = (server.address() as AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {}, body: method === 'GET' ? undefined : '{}' });
		return res.status;
	} finally { server.close(); }
}

test('every /admin router: no token 401; client / provider / affiliate 403; admin, super admin and a super admin acting as CLIENT pass the guard', async () => {
	const express = (await import('express')).default;
	const imports = importedRouters();
	const { globalErrorHandler: errorHandler } = await import('../middlewares/error.middleware');
	for (const { prefix, ident } of adminMounts) {
		const ref = imports.get(ident);
		assert.ok(ref, `router import for ${ident}`);
		const mod: any = await import(`${ref!.file.replace('./routes/', './')}.ts`);
		const router = mod[ref!.name];
		assert.ok(router, `router export ${ref!.name} of ${ref!.file}`);
		const app = express();
		app.use(express.json());
		app.use(`/admin/${prefix}`, router);
		app.use(errorHandler as any);
		// first GET route of the router (a path with params is called with a dummy id)
		const layer = (router.stack as any[]).find(l => l.route && l.route.methods.get);
		assert.ok(layer, `${prefix} has a GET route`);
		const url = `/admin/${prefix}${String(layer.route.path === '/' ? '' : layer.route.path).replace(/:\w+/g, 'x')}`;
		assert.equal(await request(app, 'GET', url), 401, `${prefix}: no token`);
		for (const who of ['client', 'provider', 'affiliate']) assert.equal(await request(app, 'GET', url, tokenFor(who)), 403, `${prefix}: ${who}`);
		for (const who of ['admin', 'superAdmin', 'superAdminActingClient']) {
			const status = await request(app, 'GET', url, tokenFor(who));
			assert.ok(status !== 401 && status !== 403, `${prefix}: ${who} must pass the guard (got ${status})`);
		}
	}
});

test('every non-GET route of every admin router is also behind the guard (a normal role gets 403, no token 401)', async () => {
	const express = (await import('express')).default;
	const imports = importedRouters();
	const { globalErrorHandler: errorHandler } = await import('../middlewares/error.middleware');
	for (const { prefix, ident } of adminMounts) {
		const ref = imports.get(ident)!;
		const router = ((await import(`${ref.file.replace('./routes/', './')}.ts`)) as any)[ref.name];
		const app = express();
		app.use(express.json());
		app.use(`/admin/${prefix}`, router);
		app.use(errorHandler as any);
		for (const layer of (router.stack as any[]).filter(l => l.route)) {
			for (const method of Object.keys(layer.route.methods).filter(m => m !== 'get')) {
				const url = `/admin/${prefix}${String(layer.route.path === '/' ? '' : layer.route.path).replace(/:\w+/g, 'x')}`;
				assert.equal(await request(app, method.toUpperCase(), url), 401, `${method} ${url}: no token`);
				assert.equal(await request(app, method.toUpperCase(), url, tokenFor('client')), 403, `${method} ${url}: client`);
				assert.equal(await request(app, method.toUpperCase(), url, tokenFor('provider')), 403, `${method} ${url}: provider`);
			}
		}
	}
});

test('DELETE /admin/users/:id is SUPER_ADMIN only: an ADMIN is refused', async () => {
	const express = (await import('express')).default;
	const { globalErrorHandler: errorHandler } = await import('../middlewares/error.middleware');
	const router = ((await import('./admin-users.routes.ts')) as any).default;
	const app = express();
	app.use(`/admin/users`, router);
	app.use(errorHandler as any);
	assert.equal(await request(app, 'DELETE', '/admin/users/x', tokenFor('admin')), 403);
});
