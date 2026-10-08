import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// AUD-FND-000036 / 000053: nothing in a profile save body can change the account's status, type, roles or verification flags. updateProfile (PUT
// /profiles/update) and updateTab (PUT /profiles/update/:tab) write only an explicit allow-list; everything else in the body is ignored.
const state: { user: any; userUpdates: any[]; upserts: any[] } = { user: { id: 'u1', status: 'ACTIVE' }, userUpdates: [], upserts: [] };
const tx: any = {
	user: { findUnique: async () => ({ ...state.user }), update: async (a: any) => { state.userUpdates.push(a.data); return { ...state.user, ...a.data }; } },
	clientProfile: { upsert: async (a: any) => { state.upserts.push(['client', a]); return { ...a.update }; }, update: async (a: any) => ({ ...a.data }), findUnique: async () => null },
	providerProfile: { upsert: async (a: any) => { state.upserts.push(['provider', a]); return { ...a.update }; }, update: async (a: any) => ({ id: 'p1', ...a.data }), findUnique: async () => ({ userId: 'u1', skills: [], portfolioItems: [] }) },
	affiliateProfile: { upsert: async (a: any) => { state.upserts.push(['affiliate', a]); return { ...a.update }; }, update: async (a: any) => ({ id: 'a1', ...a.data }), findUnique: async () => ({ avatarUrl: null, bio: null }) },
};
const prisma: any = { ...tx, user: { ...tx.user, updateMany: async () => ({ count: 0 }) }, $transaction: async (fn: any) => fn(tx) };

const disconnects: string[] = [];
let loaded: Promise<any> | undefined;
function svc() {
	loaded ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../utils/socket-registry', { namedExports: { disconnectUserSockets: async (id: string) => { disconnects.push(id); return 1; } } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		return (await import('./profile.service.ts')).profileService;
	})();
	return loaded;
}
const reset = (user: any = { id: 'u1', status: 'ACTIVE' }) => { state.user = user; state.userUpdates = []; state.upserts = []; };

const HOSTILE = {
	accountType: 'SUPER_ADMIN', status: 'ACTIVE', roles: ['SUPER_ADMIN', 'ADMIN'], activeRole: 'ADMIN', isNafathVerified: true, kycStatus: 'VERIFIED', isVerified: true,
	id: 'someone-else', userId: 'someone-else', email: 'x@y.z', password: 'pw', idDocumentUrl: 'https://x/y', idNumber: '1', profileCompletionPercent: 100, role: 'ADMIN',
};

for (const status of ['PENDING_VERIFICATION', 'SUSPENDED', 'SUSPENDED_REVIEW', 'ACTIVE']) {
	test(`updateProfile never writes User.status (user is ${status}): a profile save cannot reactivate or upgrade an account`, async () => {
		reset({ id: 'u1', status });
		const service = await svc();
		await service.updateProfile('u1', 'CLIENT', { bio: 'نبذة' } as any);
		for (const data of state.userUpdates) assert.equal('status' in data, false, JSON.stringify(data));
	});
}

for (const tab of ['basics', 'contact']) {
	test(`updateTab(${tab}) writes only the allow-list: a hostile body (accountType/status/roles/isNafathVerified/…) reaches no table`, async () => {
		reset();
		const service = await svc();
		await service.updateTab('u1', tab, { ...HOSTILE, firstName: 'أحمد', lastName: 'علي', alternativePhone: '0500000001', city: 'الرياض', address: 'عنوان', region: 'منطقة', avatarUrl: 'https://a/b.png' }, 'CLIENT');
		const forbidden = ['accountType', 'status', 'roles', 'activeRole', 'isNafathVerified', 'kycStatus', 'isVerified', 'id', 'email', 'password', 'idDocumentUrl', 'idNumber', 'profileCompletionPercent', 'role', 'phoneNumber'];
		const written = [...state.userUpdates, ...state.upserts.flatMap(([, a]) => [a.create ?? {}, a.update ?? {}])];
		for (const data of written) for (const key of forbidden) assert.equal(key in data, false, `${tab}: ${key} must never be written (${JSON.stringify(Object.keys(data))})`);
		for (const [, a] of state.upserts) assert.equal(a.create?.userId ?? 'u1', 'u1', 'a body userId can never redirect the write');
		const userData = state.userUpdates.at(0) ?? {};
		assert.deepEqual(Object.keys(userData).sort(), ['address', 'alternativePhone', 'city', 'region']);
	});
}

test('updateTab(identity): a hostile body alone is refused (400) and reaches no table; with a place it writes ClientProfile only, never User', async () => {
	reset();
	const service = await svc();
	await assert.rejects(() => service.updateTab('u1', 'identity', { ...HOSTILE }, 'CLIENT'), (e: any) => e.statusCode === 400);
	assert.equal(state.userUpdates.length, 0);
	assert.equal(state.upserts.length, 0);
	await service.updateTab('u1', 'identity', { ...HOSTILE, idNumber: undefined, city: 'جدة' }, 'CLIENT');
	assert.equal(state.userUpdates.length, 0);
	assert.equal(state.upserts.length, 1);
	for (const key of Object.keys(state.upserts[0][1].update)) assert.ok(['country', 'city'].includes(key), key);
});

test('updateTab(banking) without a PayPal email is refused (400): no bank field is applied and nothing is written', async () => {
	reset();
	const service = await svc();
	await assert.rejects(() => service.updateTab('u1', 'banking', { ...HOSTILE, iban: 'SA00' }, 'CLIENT'), (e: any) => e.statusCode === 400);
	assert.equal(state.userUpdates.length, 0);
	assert.equal(state.upserts.length, 0);
});

test('an unknown tab is a 400', async () => {
	reset();
	const service = await svc();
	await assert.rejects(() => service.updateTab('u1', 'admin', HOSTILE, 'CLIENT'), (e: any) => e.statusCode === 400);
});

test('identity/banking tabs never change the account status and never cut sockets (no PENDING_VERIFICATION lockout)', async () => {
	reset();
	disconnects.length = 0;
	const calls: any[] = [];
	prisma.user.updateMany = async (a: any) => { calls.push(a); return { count: 1 }; };
	const service = await svc();
	await service.updateTab('u1', 'identity', { city: 'جدة' }, 'CLIENT');
	await assert.rejects(() => service.updateTab('u1', 'banking', { iban: 'SA00' }, 'CLIENT'));
	assert.equal(calls.length, 0);
	assert.equal(state.userUpdates.length, 0);
	assert.deepEqual(disconnects, []);
});
