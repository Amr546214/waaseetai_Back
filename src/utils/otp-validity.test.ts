import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingMinutes, otpValidityText } from './otp-validity';

// The first deployed version said «9 دقائق» in the mail of a code issued a few milliseconds earlier (floor of 9.99). The wording must be exact for a fresh code
// and conservative for a re-sent one.
const NOW = 1_000_000_000_000;
const at = (msLeft: number) => new Date(NOW + msLeft);

test('a code issued just now (a few ms to a second of processing) is 10 minutes', () => {
	for (const processing of [0, 5, 40, 900, 2900]) assert.equal(remainingMinutes(at(600_000 - processing), NOW), 10);
});
test('a re-sent code states the whole minutes really left, rounded down', () => {
	assert.equal(remainingMinutes(at(4 * 60_000 + 30_000), NOW), 4);
	assert.equal(remainingMinutes(at(485_055), NOW), 8);
	assert.equal(remainingMinutes(at(3 * 60_000), NOW), 3);
	assert.equal(remainingMinutes(at(3 * 60_000 - 10_000), NOW), 2);
});
test('never 0 and never more than the real time (beyond the 3 s grace)', () => {
	assert.equal(remainingMinutes(at(20_000), NOW), 1);
	assert.equal(remainingMinutes(at(-5_000), NOW), 1);
	assert.equal(remainingMinutes(at(9 * 60_000 + 55_000), NOW), 9);
});
test('the wording of the minutes', () => {
	assert.equal(otpValidityText(10), '10 دقائق'); assert.equal(otpValidityText(2), 'دقيقتين'); assert.equal(otpValidityText(1), 'دقيقة واحدة'); assert.equal(otpValidityText(4), '4 دقائق');
});
