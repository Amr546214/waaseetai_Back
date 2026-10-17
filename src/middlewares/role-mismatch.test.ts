import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET ??= 'test-secret';

const run = async (user: any) => {
	const { authorizeActiveRole } = await import('./auth.middleware');
	const { AccountType } = await import('@prisma/client');
	let err: any; authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL)({ user } as any, {} as any, (e?: any) => { err = e; });
	return err;
};

test('role mismatch: a provider acting as client is told to switch role (specific message, code, canSwitch)', async () => {
	const e = await run({ id: 'u', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'CLIENT' });
	assert.equal(e.statusCode, 403); assert.equal(e.code, 'ROLE_MISMATCH'); assert.equal(e.canSwitch, true);
	assert.match(e.message, /مقدم الخدمة/); assert.match(e.message, /العميل/); assert.match(e.message, /بدّل الدور/);
});

test('role mismatch: an account without the role is told to add it; the right role passes', async () => {
	const e = await run({ id: 'u', accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' });
	assert.equal(e.canSwitch, false); assert.match(e.message, /إضافة حساب/);
	assert.equal(await run({ id: 'u', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER' }), undefined);
});
