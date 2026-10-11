import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// PUT /profiles/update/:tab ('basics' / 'contact'): the e-mail and the account phone are immutable for every role. A different value is a 403 (nothing written,
// no code, no request); the same value, '' and null are ignored; only WhatsApp / city / address are saved.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const writes: any[] = [];
const CURRENT = { email: 'me@example.com', phoneNumber: '1025073026' };
const tx: any = {
	user: { findUnique: async () => ({ id: 'u1', ...CURRENT }), update: async (a: any) => { writes.push(a.data); return { id: 'u1', ...a.data }; } },
	clientProfile: { upsert: async (a: any) => ({ ...a.update }), update: async (a: any) => ({ ...a.data }), findUnique: async () => null },
	providerProfile: { findUnique: async () => null }, affiliateProfile: { findUnique: async () => null },
};
let loaded: Promise<any> | undefined;
const svc = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: { ...tx, $transaction: async (fn: any) => fn(tx) } } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	return (await import('./profile.service.ts')).profileService;
})());
const run = (data: any, role = 'CLIENT') => svc().then(s => s.updateTab('u1', 'contact', data, role as any));

test('a DIFFERENT e-mail or phone is refused (403, display-only message) and nothing is written', async () => {
	writes.length = 0;
	await assert.rejects(() => run({ phoneNumber: '1011122244' }), (e: any) => e.statusCode === 403 && /للعرض فقط/.test(e.message));
	await assert.rejects(() => run({ email: 'other@example.com', alternativePhone: '+201025073030' }), (e: any) => e.statusCode === 403);
	assert.equal(writes.length, 0);
});

test('the SAME e-mail / phone, empty values and WhatsApp-only saves work; the answer no longer talks about a verification step', async () => {
	writes.length = 0;
	const r = await run({ email: 'ME@example.com', phoneNumber: '1025073026', alternativePhone: '+201025073030', city: 'القاهرة' });
	assert.equal(r.message, 'تم التحديث');
	assert.deepEqual(writes[0], { alternativePhone: '+201025073030', city: 'القاهرة' });
	await run({ email: '', phoneNumber: null, alternativePhone: '' });
});
