import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDevLoginOtpBypassEmail } from './dev-login-otp-bypass';

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

test('both switches on and the address listed: bypass (case and spaces ignored)', () => {
	assert.equal(isDevLoginOtpBypassEmail('Dev.Tester@WaseetAI.com', env({ SETUP_TEST_DEV_FALLBACK: 'true', DEV_LOGIN_OTP_BYPASS_EMAILS: ' a@x.com , dev.tester@waseetai.com ' })), true);
});
test('without the dev flag nothing is bypassed, even when the list is set (the official site never has the flag)', () => {
	assert.equal(isDevLoginOtpBypassEmail('a@x.com', env({ DEV_LOGIN_OTP_BYPASS_EMAILS: 'a@x.com' })), false);
	assert.equal(isDevLoginOtpBypassEmail('a@x.com', env({ SETUP_TEST_DEV_FALLBACK: 'false', DEV_LOGIN_OTP_BYPASS_EMAILS: 'a@x.com' })), false);
});
test('an empty list, an unlisted address, a partial match or an empty email never bypasses', () => {
	const on = { SETUP_TEST_DEV_FALLBACK: 'true' };
	assert.equal(isDevLoginOtpBypassEmail('a@x.com', env(on)), false);
	assert.equal(isDevLoginOtpBypassEmail('a@x.com', env({ ...on, DEV_LOGIN_OTP_BYPASS_EMAILS: '' })), false);
	assert.equal(isDevLoginOtpBypassEmail('b@x.com', env({ ...on, DEV_LOGIN_OTP_BYPASS_EMAILS: 'a@x.com' })), false);
	assert.equal(isDevLoginOtpBypassEmail('a@x.com', env({ ...on, DEV_LOGIN_OTP_BYPASS_EMAILS: 'aa@x.com,ba@x.com' })), false);
	assert.equal(isDevLoginOtpBypassEmail('', env({ ...on, DEV_LOGIN_OTP_BYPASS_EMAILS: 'a@x.com,' })), false);
	assert.equal(isDevLoginOtpBypassEmail(null, env({ ...on, DEV_LOGIN_OTP_BYPASS_EMAILS: ',' })), false);
});

import { otpCodeFor, DEV_TEST_ACCOUNT_OTP_CODE } from './dev-login-otp-bypass';
test('otpCodeFor: the fixed code only for a listed account on dev; everyone else (and the official site) keeps the random code', () => {
	const dev = env({ SETUP_TEST_DEV_FALLBACK: 'true', DEV_LOGIN_OTP_BYPASS_EMAILS: 'a@x.com' });
	assert.equal(otpCodeFor('a@x.com', '123456', dev), DEV_TEST_ACCOUNT_OTP_CODE);
	assert.equal(otpCodeFor('b@x.com', '123456', dev), '123456');
	assert.equal(otpCodeFor('a@x.com', '123456', env({ DEV_LOGIN_OTP_BYPASS_EMAILS: 'a@x.com' })), '123456');
	assert.equal(otpCodeFor(undefined, '123456', dev), '123456');
});
