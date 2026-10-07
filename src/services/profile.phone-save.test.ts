import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';

// #26 — profile save: a valid phone number only, written only when it CHANGED, never erased by ''/null, and a duplicate number is a 409 whose
// message does not reveal that the number belongs to another account.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const state: { stored: string | null; updates: any[]; failWith: any } = { stored: '0500000000', updates: [], failWith: null };
const tx: any = {
	user: {
		findUnique: async () => ({ id: 'u1', status: 'ACTIVE', phoneNumber: state.stored }),
		update: async (a: any) => { if (state.failWith) throw state.failWith; state.updates.push(a.data); return { id: 'u1', status: 'ACTIVE', ...a.data }; }
	},
	clientProfile: { upsert: async (a: any) => ({ ...a.update }), update: async (a: any) => ({ ...a.data }), findUnique: async () => null }
};
let loaded: Promise<any> | undefined;
const svc = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: { ...tx, $transaction: async (fn: any) => fn(tx) } } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	return (await import('./profile.service.ts')).profileService;
})());
const reset = () => { state.stored = '0500000000'; state.updates = []; state.failWith = null; };
const parse = (phoneNumber: any) => updateProfileSchema.safeParse({ phoneNumber });

test('schema: a valid number passes (spaces / dashes stripped); letters, too short and too long are rejected with an Arabic message', () => {
	assert.equal((parse('0500 000-001') as any).data.phoneNumber, '0500000001');
	for (const bad of ['abc12345678', '12345', '1'.repeat(16), '+9665000000']) {
		const r = parse(bad);
		assert.equal(r.success, false, bad);
		assert.match((r as any).error.issues[0].message, /رقم الجوال/);
	}
});

test("schema: '' and null mean 'not provided' (never an error, never an erase)", () => {
	for (const v of ['', null, undefined]) assert.equal((parse(v) as any).data.phoneNumber, undefined);
});

test('an unchanged phone number is not written at all', async () => {
	reset();
	await (await svc()).updateProfile('u1', 'CLIENT', { phoneNumber: '0500000000' } as any);
	assert.equal(state.updates.length, 0);
});

test('a changed phone number is written, and nothing else on User', async () => {
	reset();
	await (await svc()).updateProfile('u1', 'CLIENT', { phoneNumber: '0511111111' } as any);
	assert.deepEqual(state.updates, [{ phoneNumber: '0511111111' }]);
});

test('no phone in the body (or empty after parsing) leaves the stored number untouched', async () => {
	reset();
	await (await svc()).updateProfile('u1', 'CLIENT', { phoneNumber: undefined, bio: 'x' } as any);
	assert.equal(state.updates.length, 0);
});

test('a number that belongs to another account is a 409 with a generic message (no "already registered", no field / constraint name)', async () => {
	reset();
	state.failWith = Object.assign(new Error('Unique constraint failed on the fields: (`phoneNumber`)'), { code: 'P2002', meta: { target: ['phoneNumber'] } });
	await assert.rejects(() => svc().then(s => s.updateProfile('u1', 'CLIENT', { phoneNumber: '0522222222' } as any)), (e: any) => {
		assert.equal(e.statusCode, 409);
		assert.match(e.message, /[؀-ۿ]/);
		assert.doesNotMatch(e.message, /مسجل|مستخدم|موجود|phone|unique/i);
		return true;
	});
});

test('any other database error is not disguised as a 409', async () => {
	reset();
	state.failWith = new Error('connection lost');
	await assert.rejects(() => svc().then(s => s.updateProfile('u1', 'CLIENT', { phoneNumber: '0533333333' } as any)), /connection lost/);
});
