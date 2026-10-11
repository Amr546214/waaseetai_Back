import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneChangeController } from '../../controllers/phone-change.controller';
import { CONTACT_IMMUTABLE_MESSAGE } from '../../utils/contact-policy';

// The account phone is immutable from the interface for EVERY role: the old code flow (/profiles/phone/change/*) always refuses.
const call = (fn: 'request' | 'confirm') => {
	let status = 0; let body: any;
	const res: any = { status(c: number) { status = c; return res; }, json(b: any) { body = b; return res; } };
	(phoneChangeController[fn] as any)({ user: { userId: 'u1' }, body: { phoneNumber: '0511111111', code: '123456' } }, res);
	return { status, body };
};

test('POST /profiles/phone/change/request and /confirm answer 403 CONTACT_IMMUTABLE with the display-only message (no code is sent, nothing is changed)', () => {
	for (const fn of ['request', 'confirm'] as const) {
		const r = call(fn);
		assert.equal(r.status, 403, fn);
		assert.equal(r.body.code, 'CONTACT_IMMUTABLE', fn);
		assert.equal(r.body.message, CONTACT_IMMUTABLE_MESSAGE, fn);
	}
});

test('the routes are still registered (an old client gets a clear refusal, not a 404) and the phone-change service is gone', async () => {
	const { readFileSync, existsSync } = await import('node:fs');
	const routes = readFileSync(new URL('./profile.routes.ts', import.meta.url), 'utf8');
	assert.match(routes, /\/phone\/change\/request/);
	assert.equal(existsSync(new URL('../../services/phone-change.service.ts', import.meta.url)), false);
});
