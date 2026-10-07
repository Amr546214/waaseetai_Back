import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from './profile.controller';
import { profileService } from '../services/profile.service';

// PUT /profiles/update/:tabName goes through the tab's Zod schema: bad types / over-long values are a structured 400 and never reach the service;
// the payloads the current UI tabs send still pass, and unknown keys are stripped.
function createMockRes() {
	const res: any = { statusCode: null, body: null };
	res.status = (c: number) => { res.statusCode = c; return res; };
	res.json = (b: any) => { res.body = b; return res; };
	return res;
}
const reqWith = (tabName: string, body: any): any => ({ params: { tabName }, body, user: { userId: 'u1', activeRole: 'CLIENT' } });
const controller = new ProfileController();

test('over-long and wrong-typed values are a 400 with the field named, and the service is never called', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	for (const [tab, body, field] of [
		['basics', { firstName: 'س'.repeat(51) }, 'firstName'],
		['basics', { lastName: 12345 }, 'lastName'],
		['contact', { address: 'x'.repeat(301) }, 'address'],
		['contact', { city: ['a'] }, 'city'],
		['contact', { alternativePhone: '1'.repeat(21) }, 'alternativePhone'],
		['banking', { paypalPayoutEmail: 'x'.repeat(300) }, 'paypalPayoutEmail'],
		['banking', { paymentMethod: 'crypto' }, 'paymentMethod'],
	] as const) {
		const res = createMockRes();
		await controller.updateTab(reqWith(tab, body), res, () => {});
		assert.equal(res.statusCode, 400, `${tab}.${field}`);
		assert.equal(res.body.errors[0].field, field);
		assert.match(res.body.message, /[؀-ۿ]/);
	}
	assert.equal(update.mock.callCount(), 0);
});

test('the payloads the current UI tabs send still pass (basics, contact with empty values, banking PayPal set/clear)', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	for (const [tab, body] of [
		['basics', { firstName: 'سارة', lastName: 'أحمد' }],
		['contact', { alternativePhone: '', city: 'الرياض' }],
		['contact', { alternativePhone: null, address: '', region: '' }],
		['banking', { paypalPayoutEmail: 'a@b.com' }],
		['banking', { paypalPayoutEmail: null }],
		['banking', { paypalPayoutEmail: '' }],
	] as const) {
		const res = createMockRes();
		await controller.updateTab(reqWith(tab, body), res, () => {});
		assert.equal(res.statusCode, 200, JSON.stringify(body));
	}
	assert.equal(update.mock.callCount(), 6);
});

test('unknown keys (accountType/status/roles/…) are stripped before the service sees the body', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	const res = createMockRes();
	await controller.updateTab(reqWith('basics', { firstName: 'سارة', accountType: 'ADMIN', status: 'ACTIVE', roles: ['ADMIN'], isNafathVerified: true }), res, () => {});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(update.mock.calls[0].arguments[2], { firstName: 'سارة' });
});

test('an unknown tab still reaches the service (its 400), and a service failure goes to next()', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => { throw new Error('boom'); });
	let err: unknown = null;
	await controller.updateTab(reqWith('whatever', { a: 1 }), createMockRes(), (e?: unknown) => { err = e; });
	assert.ok(err instanceof Error);
	assert.equal(update.mock.callCount(), 1);
});
