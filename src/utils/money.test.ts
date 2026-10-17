import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2, sumMoney } from './money';

test('round2 removes float noise from live-run figures', () => {
	assert.equal(17.45 - 8.72, 8.729999999999999);
	assert.equal(round2(17.45 - 8.72), 8.73);
	assert.equal(round2(17.45 + 43.62), 61.07);
	assert.equal(round2(61.06999999999999), 61.07);
	assert.equal(round2(70 * 12.75 / 100), 8.93);
	assert.equal(round2(-1.005), -1.01);
	assert.equal(round2(NaN), 0);
});
test('sumMoney sums then rounds once', () => {
	assert.equal(sumMoney([17.45, 43.62]), 61.07);
	assert.equal(sumMoney([]), 0);
});
