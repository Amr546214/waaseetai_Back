import test from 'node:test';
import assert from 'node:assert/strict';
import { otpSendThrottle } from '../utils/otp-send-throttle';

test('sensitive-change throttle key blocks a 2nd code within 60s only after a delivered mail', () => {
	const key = 'sensitive-change:t1';
	const r1 = otpSendThrottle.reserve(key, '1.1.1.1');
	assert.equal(r1.allowed, true);
	otpSendThrottle.releaseIp('1.1.1.1'); // failed mail: nothing recorded
	assert.equal(otpSendThrottle.reserve(key, '1.1.1.1').allowed, true);
	otpSendThrottle.commitRecipient(key, true);
	const r3 = otpSendThrottle.reserve(key, '1.1.1.1');
	assert.equal(r3.allowed, false);
	assert.ok((r3.retryAfterSeconds ?? 0) > 0 && (r3.retryAfterSeconds ?? 0) <= 60);
});
