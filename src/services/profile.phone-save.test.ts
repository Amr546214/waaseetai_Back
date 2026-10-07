import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';

// #26 — profile save: a valid phone number only, never erased by ''/null, and a CHANGED number is refused here (it is changed only through the
// email-OTP flow, see routes/phone-change.flow.test.ts, which also covers the duplicate-number 409).
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

test('a CHANGED phone number is refused here (400, Arabic): it is changed only through the email-OTP flow, and nothing is written', async () => {
	reset();
	await assert.rejects(() => svc().then(s => s.updateProfile('u1', 'CLIENT', { phoneNumber: '0511111111' } as any)), (e: any) => {
		assert.equal(e.statusCode, 400);
		assert.match(e.message, /رمز تحقق/);
		return true;
	});
	assert.equal(state.updates.length, 0);
});

test('no phone in the body leaves the stored number untouched', async () => {
	reset();
	await (await svc()).updateProfile('u1', 'CLIENT', { phoneNumber: undefined, bio: 'x' } as any);
	assert.equal(state.updates.length, 0);
});
