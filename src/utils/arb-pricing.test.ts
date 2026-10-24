import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceArbDeposit } from './arb-pricing';

// FIXTURE inputs only: no fee percent and no SAR rate is approved. These tests prove the ARITHMETIC (exact decimals, half-up, cents add up).
test('worked example: net 100, fee 2.5 %, 3.75 -> gross 102.56, fee 2.56, charge 384.60 SAR; net + fee = gross exactly', () => {
	const p = priceArbDeposit(100, 2.5, 3.75);
	assert.equal(p.gross.toFixed(2), '102.56'); assert.equal(p.fee.toFixed(2), '2.56'); assert.equal(p.chargeSar.toFixed(2), '384.60');
	assert.equal(p.net.plus(p.fee).toFixed(2), p.gross.toFixed(2));
});
test('zero fee: gross = net; charge = net x rate', () => {
	const p = priceArbDeposit(50, 0, 3.75);
	assert.equal(p.gross.toFixed(2), '50.00'); assert.equal(p.fee.toFixed(2), '0.00'); assert.equal(p.chargeSar.toFixed(2), '187.50');
});
test('rounding is HALF-UP at 2 decimals, in each of the two steps, with decimal (not float) arithmetic', () => {
	assert.equal(priceArbDeposit(100.005, 0, 1).net.toFixed(2), '100.01');
	assert.equal(priceArbDeposit(100, 0, 1.005).chargeSar.toFixed(2), '100.50'); // 100 x 1.005 = 100.5 exactly
	assert.equal(priceArbDeposit(1, 0, 1.005).chargeSar.toFixed(2), '1.01'); // 1.005 -> half-up 1.01 (a float implementation gives 1.00)
});
test('refuses absurd inputs instead of guessing', () => {
	assert.throws(() => priceArbDeposit(100, -1, 3.75), RangeError);
	assert.throws(() => priceArbDeposit(100, 50, 3.75), RangeError);
	assert.throws(() => priceArbDeposit(100, 2, 0), RangeError);
});
