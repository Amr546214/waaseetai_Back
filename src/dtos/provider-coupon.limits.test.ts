import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCouponSchema, updateCouponSchema } from './cart-checkout.dto';

const SID = '11111111-1111-4111-8111-111111111111';
const base = { code: 'save10', discountType: 'percentage', discountValue: 10, serviceIds: [SID] };
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

test('create: percentage must be between 1 and 100', () => {
	assert.equal(createCouponSchema.safeParse({ ...base, discountValue: 100 }).success, true);
	assert.equal(createCouponSchema.safeParse({ ...base, discountValue: 1 }).success, true);
	assert.equal(createCouponSchema.safeParse({ ...base, discountValue: 101 }).success, false);
	assert.equal(createCouponSchema.safeParse({ ...base, discountValue: 0.5 }).success, false);
	assert.equal(createCouponSchema.safeParse({ ...base, discountValue: 0 }).success, false);
});
test('create: maxUses must be a positive integer, serviceIds are required, code is upper-cased', () => {
	assert.equal(createCouponSchema.safeParse({ ...base, maxUses: 0 }).success, false);
	assert.equal(createCouponSchema.safeParse({ ...base, maxUses: 1.5 }).success, false);
	assert.equal(createCouponSchema.safeParse({ ...base, serviceIds: [] }).success, false);
	const ok = createCouponSchema.safeParse({ ...base, maxUses: 5 });
	assert.equal(ok.success && ok.data.code, 'SAVE10');
});
test('create: the expiry must be in the future and after the start', () => {
	assert.equal(createCouponSchema.safeParse({ ...base, expiresAt: future() }).success, true);
	assert.equal(createCouponSchema.safeParse({ ...base, expiresAt: past() }).success, false);
	assert.equal(createCouponSchema.safeParse({ ...base, startAt: future(), expiresAt: new Date(Date.now() + 1000).toISOString() }).success, false);
});
test('update: the same limits apply to a partial update', () => {
	assert.equal(updateCouponSchema.safeParse({ expiresAt: past() }).success, false);
	assert.equal(updateCouponSchema.safeParse({ discountType: 'percentage', discountValue: 150 }).success, false);
	assert.equal(updateCouponSchema.safeParse({ maxUses: -1 }).success, false);
	assert.equal(updateCouponSchema.safeParse({ expiresAt: future(), active: false }).success, true);
});
