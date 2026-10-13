import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateOrderDiscount, splitByWeights, round2 } from './order-discount';

const sum = (m: Map<string, number>) => round2([...m.values()].reduce((a, b) => a + b, 0));

test('no discount => every item keeps its full price (shares are 0)', () => {
	const m = allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 20 }], 0, null);
	assert.deepEqual([...m.entries()], [['a', 0]]);
});
test('a 10% coupon on a 20 service => the item carries the whole 2 discount (net 18)', () => {
	const m = allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 20 }], 2, { serviceIds: ['s1'], excludedServiceIds: [] });
	assert.equal(m.get('a'), 2);
});
test('only the coupon\'s services take the discount; the rest are untouched', () => {
	const m = allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 100 }, { id: 'b', serviceId: 's2', price: 50 }], 10, { serviceIds: ['s1'], excludedServiceIds: [] });
	assert.equal(m.get('a'), 10); assert.equal(m.get('b'), 0);
});
test('excluded services never take the discount; an empty service list means "all"', () => {
	const m = allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 100 }, { id: 'b', serviceId: 's2', price: 100 }], 20, { serviceIds: [], excludedServiceIds: ['s2'] });
	assert.equal(m.get('a'), 20); assert.equal(m.get('b'), 0);
});
test('several eligible items share pro rata and the shares add up to the discount EXACTLY (rounding remainder on the last)', () => {
	const m = allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 33.33 }, { id: 'b', serviceId: 's2', price: 33.33 }, { id: 'c', serviceId: 's3', price: 33.34 }], 10, null);
	assert.equal(sum(m), 10);
	for (const v of m.values()) assert.ok(v > 0 && v < 4);
});
test('a discount never exceeds the eligible value (capped) and an inconsistent scope spreads over the whole order', () => {
	assert.equal(allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 5 }], 99, null).get('a'), 5);
	const m = allocateOrderDiscount([{ id: 'a', serviceId: 's1', price: 40 }], 4, { serviceIds: ['other'], excludedServiceIds: [] });
	assert.equal(m.get('a'), 4);
});
test('splitByWeights: no discount keeps stage amounts exactly as published', () => {
	assert.deepEqual(splitByWeights([12, 8], 20), [12, 8]);
});
test('splitByWeights: with a discount the stage amounts scale and add up to the net EXACTLY', () => {
	assert.deepEqual(splitByWeights([12, 8], 18), [10.8, 7.2]);
	const parts = splitByWeights([33.33, 33.33, 33.34], 90);
	assert.equal(round2(parts.reduce((a, b) => a + b, 0)), 90);
	assert.deepEqual(splitByWeights([], 10), []);
	assert.deepEqual(splitByWeights([0, 0], 10).reduce((a, b) => a + b, 0), 10);
});
