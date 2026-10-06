import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// A real Express app + the REAL client-profile router with the REAL authenticate/requireActiveUser middlewares; only the database,
// the session store and the controller handlers are replaced. Proves the PR #38 wiring end to end: a new client who has completed
// OTP (status ACTIVE) reaches /client/profile/setup, one who has not (PENDING_VERIFICATION) or is SUSPENDED is refused, and the
// public profile route needs no token.
process.env.JWT_SECRET = 'flow-test-secret';
process.env.OPENAI_API_KEY = 'x';

let status = 'PENDING_VERIFICATION';
const prisma: any = { user: { findUnique: async () => ({ id: 'u1', email: 'new@example.com', accountType: 'CLIENT_INDIVIDUAL', status, activeRole: 'CLIENT', roles: ['CLIENT'] }) } };
const ok = (name: string) => async (_req: any, res: any) => res.status(200).json({ success: true, handler: name });

let serverPromise: Promise<{ url: string; close: () => void }> | undefined;
function server() {
	serverPromise ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
		mock.module('../controllers/client-profile.controller', {
			namedExports: { clientProfileController: { getPublicProfile: ok('public'), getSetupData: ok('getSetup'), saveSetupData: ok('saveSetup'), nafathVerify: ok('nafath') } },
		});
		const express = (await import('express')).default;
		const router = (await import('./client-profile.routes')).default;
		const app = express();
		app.use(express.json());
		app.use('/api/client/profile', router);
		app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
		const srv = http.createServer(app);
		await new Promise<void>(r => srv.listen(0, r));
		return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
	})();
	return serverPromise;
}
const token = () => jwt.sign({ userId: 'u1', accountType: 'CLIENT_INDIVIDUAL' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
async function call(method: string, path: string, withToken = true) {
	const { url } = await server();
	const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(withToken ? { authorization: `Bearer ${token()}` } : {}) }, body: method === 'POST' ? '{}' : undefined });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('a new client who completed OTP (ACTIVE) reaches GET and POST /client/profile/setup', async () => {
	status = 'ACTIVE';
	const g = await call('GET', '/api/client/profile/setup');
	assert.equal(g.status, 200);
	assert.equal(g.body.handler, 'getSetup');
	const p = await call('POST', '/api/client/profile/setup');
	assert.equal(p.status, 200);
	assert.equal(p.body.handler, 'saveSetup');
});

test('a client still awaiting OTP activation (PENDING_VERIFICATION) is refused with 403', async () => {
	status = 'PENDING_VERIFICATION';
	const g = await call('GET', '/api/client/profile/setup');
	assert.equal(g.status, 403);
	assert.match(g.body.message, /تفعيل/);
});

test('a SUSPENDED client holding a valid token is refused with 403', async () => {
	status = 'SUSPENDED';
	assert.equal((await call('GET', '/api/client/profile/setup')).status, 403);
	assert.equal((await call('POST', '/api/client/profile/nafath-verify')).status, 403);
});

test('no token: 401 on setup, while the public client profile stays reachable without one', async () => {
	status = 'ACTIVE';
	assert.equal((await call('GET', '/api/client/profile/setup', false)).status, 401);
	assert.equal((await call('GET', '/api/client/profile/public/abc', false)).status, 200);
});

test.after(async () => { (await server()).close(); });
