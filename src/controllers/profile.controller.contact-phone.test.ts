import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from './profile.controller';
import { profileService } from '../services/profile.service';

// PUT /profiles/update/contact: alternativePhone is ONE STRING. The real client bug (D2) sent the phone-input object and got an English zod message;
// the contract is now: E.164 strings pass untouched, the phone-input object with a valid e164Number is read defensively as that string, anything
// else is a field-level 400 in Arabic that names alternativePhone only.
function createMockRes() {
	const res: any = { statusCode: null, body: null };
	res.status = (c: number) => { res.statusCode = c; return res; };
	res.json = (b: any) => { res.body = b; return res; };
	return res;
}
const reqWith = (body: any): any => ({ params: { tabName: 'contact' }, body, user: { userId: 'u1', activeRole: 'CLIENT' } });
const controller = new ProfileController();

test('an E.164 string is stored as sent (UAE, Egypt, spaces kept out by the client)', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	for (const phone of ['+971501234567', '+201025073026', '+966551234567']) {
		const res = createMockRes();
		await controller.updateTab(reqWith({ alternativePhone: phone, city: 'دبي' }), res, () => {});
		assert.equal(res.statusCode, 200, phone);
	}
	assert.deepEqual(update.mock.calls[0].arguments[2], { alternativePhone: '+971501234567', city: 'دبي' });
});

test('defensive: the phone-input object with a valid e164Number is read as that string (old cached bundles), never stored as an object', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	const res = createMockRes();
	await controller.updateTab(reqWith({ alternativePhone: { countryCode: 'AE', dialCode: '+971', number: '50 123 4567', e164Number: '+971501234567' }, city: 'دبي' }), res, () => {});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(update.mock.calls[0].arguments[2], { alternativePhone: '+971501234567', city: 'دبي' });
});

test('an object without a valid e164Number, an array, a number or a boolean is a 400 on alternativePhone with an Arabic message (no English zod text), service not called', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	for (const bad of [
		{ countryCode: 'AE', dialCode: '+971', number: '501234567', e164Number: '' },
		{ e164Number: '971501234567' },
		{ e164Number: '+9715012345678901234' },
		{ e164Number: { a: 1 } },
		['+971501234567'], 971501234567, true,
	]) {
		const res = createMockRes();
		await controller.updateTab(reqWith({ alternativePhone: bad, city: 'دبي' }), res, () => {});
		assert.equal(res.statusCode, 400, JSON.stringify(bad));
		assert.equal(res.body.errors.length, 1);
		assert.equal(res.body.errors[0].field, 'alternativePhone');
		assert.match(res.body.errors[0].message, /[؀-ۿ]/);
		assert.doesNotMatch(res.body.errors[0].message, /Invalid|expected|received/);
	}
	assert.equal(update.mock.callCount(), 0);
});

test('a bad alternativePhone does not hide the other field errors: each is reported on its own field', async (t) => {
	t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	const res = createMockRes();
	await controller.updateTab(reqWith({ alternativePhone: { x: 1 }, city: ['a'] }), res, () => {});
	assert.equal(res.statusCode, 400);
	assert.deepEqual(res.body.errors.map((e: any) => e.field).sort(), ['alternativePhone', 'city']);
});

test('null / empty still clear the number and a too long string is refused in Arabic', async (t) => {
	const update = t.mock.method(profileService, 'updateTab', async () => ({ message: 'ok' }));
	for (const v of [null, '']) {
		const res = createMockRes();
		await controller.updateTab(reqWith({ alternativePhone: v }), res, () => {});
		assert.equal(res.statusCode, 200);
	}
	assert.equal(update.mock.callCount(), 2);
	const res = createMockRes();
	await controller.updateTab(reqWith({ alternativePhone: '1'.repeat(21) }), res, () => {});
	assert.equal(res.statusCode, 400);
	assert.match(res.body.errors[0].message, /[؀-ۿ]/);
});
