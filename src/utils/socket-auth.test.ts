import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

// #35 (sockets) — one handshake check for every gateway: valid JWT + live session + ACTIVE account. Real Socket.IO server and client over a
// local port; only the database and the session store are replaced.
process.env.JWT_SECRET = 'socket-auth-secret';
process.env.OPENAI_API_KEY = 'x';

const users: Record<string, any> = {
	active: { id: 'active', status: 'ACTIVE', accountType: 'CLIENT_INDIVIDUAL', isBanned: false },
	pending: { id: 'pending', status: 'PENDING_VERIFICATION', accountType: 'CLIENT_INDIVIDUAL', isBanned: false },
	suspended: { id: 'suspended', status: 'SUSPENDED', accountType: 'CLIENT_INDIVIDUAL', isBanned: false },
	review: { id: 'review', status: 'SUSPENDED_REVIEW', accountType: 'CLIENT_INDIVIDUAL', isBanned: false },
	banned: { id: 'banned', status: 'ACTIVE', accountType: 'CLIENT_INDIVIDUAL', isBanned: true },
	revoked: { id: 'revoked', status: 'ACTIVE', accountType: 'CLIENT_INDIVIDUAL', isBanned: false },
};
const tokenFor = (id: string, secret = process.env.JWT_SECRET!) => jwt.sign({ userId: id, accountType: 'CLIENT_INDIVIDUAL' }, secret, { expiresIn: '1h' });

let booted: Promise<{ url: string; close: () => void; auth: any; registry: any; adminUsers: any }> | undefined;
function boot() {
	booted ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma: {
			user: { findUnique: async ({ where }: any) => users[where.id] ?? null, update: async ({ where, data }: any) => { Object.assign(users[where.id], data); return { ...users[where.id] }; } },
		} } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async (userId: string) => (userId === 'revoked' ? null : { id: 's1' }) } } });
		const log = console.log; console.log = () => {};
		const { Server } = await import('socket.io');
		void Server;
		const { initSocketServer } = await import('../socket');
		const server = http.createServer();
		initSocketServer(server, ['*']);
		await new Promise<void>(r => server.listen(0, r));
		console.log = log;
		return {
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			close: () => { server.closeAllConnections?.(); server.close(); },
			auth: await import('./socket-auth'), registry: await import('./socket-registry'), adminUsers: await import('../services/admin-users.service'),
		};
	})();
	return booted;
}
const open = (url: string, path: string, token?: string) => new Promise<{ socket: ClientSocket; error?: any }>(resolve => {
	const socket = connect(url + path, { transports: ['websocket'], reconnection: false, auth: token ? { token } : {}, forceNew: true });
	socket.on('connect', () => resolve({ socket }));
	socket.on('connect_error', (error: any) => { socket.close(); resolve({ socket, error }); });
});

test('verifySocketToken: only an ACTIVE, not banned account with a live session passes; every other state is refused with its reason', async () => {
	const { auth } = await boot();
	assert.deepEqual(await auth.verifySocketToken(tokenFor('active')), { ok: true, userId: 'active', accountType: 'CLIENT_INDIVIDUAL' });
	for (const id of ['pending', 'suspended', 'review', 'banned']) assert.deepEqual(await auth.verifySocketToken(tokenFor(id)), { ok: false, reason: 'NOT_ACTIVE' }, id);
	assert.deepEqual(await auth.verifySocketToken(tokenFor('revoked')), { ok: false, reason: 'SESSION_REVOKED' });
	assert.deepEqual(await auth.verifySocketToken(tokenFor('ghost')), { ok: false, reason: 'NOT_FOUND' });
	assert.deepEqual(await auth.verifySocketToken('not-a-jwt'), { ok: false, reason: 'INVALID_TOKEN' });
	assert.deepEqual(await auth.verifySocketToken(tokenFor('active', 'other-secret')), { ok: false, reason: 'INVALID_TOKEN' });
	assert.deepEqual(await auth.verifySocketToken(undefined), { ok: false, reason: 'NO_TOKEN' });
	assert.equal((await auth.verifySocketToken(`"${tokenFor('active')}"`)).ok, true, 'a quoted token is accepted as before');
});

test('main namespace: an ACTIVE account connects; PENDING / SUSPENDED / SUSPENDED_REVIEW / banned / revoked-session tokens are REFUSED at connect', async () => {
	const { url } = await boot();
	const ok = await open(url, '', tokenFor('active'));
	assert.equal(ok.error, undefined);
	assert.equal(ok.socket.connected, true);
	ok.socket.close();
	for (const id of ['pending', 'suspended', 'review', 'banned']) {
		const r = await open(url, '', tokenFor(id));
		assert.ok(r.error, `${id} must be refused`);
		assert.equal(r.error.data?.code, 'ACCOUNT_NOT_ACTIVE', id);
		assert.match(r.error.message, /[؀-ۿ]/);
	}
	const revoked = await open(url, '', tokenFor('revoked'));
	assert.ok(revoked.error);
	assert.equal(revoked.error.data?.code, 'SESSION_REVOKED');
});

test('main namespace keeps serving public pages: no token, or a token that is not a valid JWT, connects as an anonymous socket (no userId, no user rooms)', async () => {
	const { url } = await boot();
	for (const token of [undefined, 'garbage', tokenFor('active', 'other-secret')]) {
		const r = await open(url, '', token);
		assert.equal(r.error, undefined, String(token).slice(0, 10));
		assert.equal(r.socket.connected, true);
		r.socket.close();
	}
});

test('/assessments is stricter: no token, a bad token and every non-active account are refused; an active one connects', async () => {
	const { url } = await boot();
	assert.ok((await open(url, '/assessments')).error, 'no token');
	assert.ok((await open(url, '/assessments', 'garbage')).error, 'bad token');
	for (const id of ['pending', 'suspended', 'review', 'banned', 'revoked']) assert.ok((await open(url, '/assessments', tokenFor(id))).error, id);
	const ok = await open(url, '/assessments', tokenFor('active'));
	assert.equal(ok.error, undefined);
	ok.socket.close();
});

test('mid-session cut: when an admin moves a connected account out of ACTIVE its live sockets (main + /assessments) are told why and disconnected; other users are untouched', async () => {
	const { url, adminUsers } = await boot();
	users.victim = { id: 'victim', status: 'ACTIVE', accountType: 'CLIENT_INDIVIDUAL', isBanned: false };
	users.bystander = { id: 'bystander', status: 'ACTIVE', accountType: 'CLIENT_INDIVIDUAL', isBanned: false };
	const a = await open(url, '', tokenFor('victim'));
	const b = await open(url, '/assessments', tokenFor('victim'));
	const other = await open(url, '', tokenFor('bystander'));
	assert.ok(a.socket.connected && b.socket.connected && other.socket.connected);
	const told: any[] = [];
	a.socket.on('account_not_active', (p: any) => told.push(p));
	const closed = Promise.all([a, b].map(s => new Promise<void>(r => s.socket.on('disconnect', () => r()))));
	const svc = new adminUsers.AdminUsersService();
	await svc.updateUserStatus('victim', 'suspended');
	await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('sockets were not cut')), 3000))]);
	assert.equal(a.socket.connected, false);
	assert.equal(b.socket.connected, false);
	assert.equal(other.socket.connected, true);
	assert.equal(told[0]?.code, 'ACCOUNT_NOT_ACTIVE');
	// and it cannot come back with the same token
	assert.ok((await open(url, '', tokenFor('victim'))).error);
	// moving an account to ACTIVE cuts nothing
	const stay = await open(url, '', tokenFor('bystander'));
	await svc.updateUserStatus('bystander', 'active');
	await new Promise(r => setTimeout(r, 200));
	assert.equal(stay.socket.connected, true);
	other.socket.close(); stay.socket.close();
});

test('a status change with no live socket (or no server registered) is a harmless no-op', async () => {
	const { registry } = await boot();
	assert.equal(await registry.disconnectUserSockets('nobody-connected'), 0);
});

after(async () => {
	const { registry } = await boot();
	for (const id of Object.keys(users)) await registry.disconnectUserSockets(id).catch(() => 0);
	(await boot()).close();
});
