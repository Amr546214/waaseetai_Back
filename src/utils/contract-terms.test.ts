import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderContractView, parseContractMilestones } from './contract-terms';

const M = (o: Record<string, unknown> = {}) => ({ id: 'm1', proposalId: 'p1', stepOrder: 1, title: 'التصميم الأولي', description: 'مسودة الشعار', days: 5, percentage: 40, amount: 400, ...o });

test('milestones are read from a normal terms snapshot, in order, with only the real fields', () => {
	const out = parseContractMilestones({ version: 1, milestones: [M({ stepOrder: 2, title: 'التسليم النهائي', percentage: 60, amount: 600, days: 9 }), M()] });
	assert.deepEqual(out.map(m => [m.order, m.title, m.days, m.percentage, m.amount]), [[1, 'التصميم الأولي', 5, 40, 400], [2, 'التسليم النهائي', 9, 60, 600]]);
	assert.equal(out[0].description, 'مسودة الشعار');
	assert.ok(!('id' in out[0]) && !('proposalId' in out[0]));
});

test('anything that is not a usable snapshot gives an empty list — never an exception, never invented milestones', () => {
	for (const bad of [null, undefined, 0, 'abc', '', '{broken', [], [1, 2], {}, { milestones: null }, { milestones: 'x' }, { milestones: {} }, { milestones: [null, 5, 'x', {}] }, { milestones: [{ title: '   ' }] }]) {
		assert.deepEqual(parseContractMilestones(bad), [], JSON.stringify(bad));
	}
});

test('terms stored as a JSON string are read; missing or invalid numbers become null (not 0, not a guess)', () => {
	const out = parseContractMilestones(JSON.stringify({ milestones: [{ title: 'مرحلة', days: 'ten', percentage: 150, amount: -5 }, { title: 'ثانية', stepOrder: 'x' }] }));
	assert.equal(out.length, 2);
	assert.deepEqual(out[0], { order: 1, title: 'مرحلة', description: null, days: null, percentage: null, amount: null });
	assert.equal(out[1].order, 2);
});

test('text is sanitised and capped; at most 20 milestones', () => {
	const out = parseContractMilestones({ milestones: [{ title: `a\u0000b\n${'x'.repeat(300)}`, description: 'd'.repeat(900) }] });
	assert.ok(!/[\u0000-\u001f]/.test(out[0].title));
	assert.ok(out[0].title.length <= 120);
	assert.ok((out[0].description as string).length <= 500);
	assert.equal(parseContractMilestones({ milestones: Array.from({ length: 30 }, (_v, i) => ({ title: `m${i}` })) }).length, 20);
});

test('the provider view carries the contract\'s own values, the saved milestones and the funded escrow', () => {
	const view = buildProviderContractView({ id: 'c1', status: 'PENDING_PROVIDER_SIGNATURE', termsVersion: 1, price: 1000, durationDays: 14, phasesCount: 2, terms: { milestones: [M()] } }, { amount: 1000, status: 'HELD' });
	assert.deepEqual({ ...view, milestones: view.milestones.length }, { id: 'c1', status: 'PENDING_PROVIDER_SIGNATURE', termsVersion: 1, price: 1000, currency: 'USD', durationDays: 14, phasesCount: 2, milestones: 1, escrow: { amount: 1000, status: 'HELD' }, providerTerms: null, termsDigest: view.termsDigest });
	assert.equal(buildProviderContractView({ id: 'c', status: 'S', termsVersion: 1, price: 5, durationDays: 3, phasesCount: 1, terms: 'garbage' }, null).escrow, null);
	assert.deepEqual(buildProviderContractView({ id: 'c', status: 'S', termsVersion: 1, price: 5, durationDays: 3, phasesCount: 1, terms: 'garbage' }, undefined).milestones, []);
});

test('once the client funded, the provider sees the FINAL commission and net frozen on the escrow; before that, none (the fee preview is the estimate)', () => {
	const c = { id: 'c1', status: 'PENDING_PROVIDER_SIGNATURE', termsVersion: 1, price: 1000, currency: 'SAR', durationDays: 14, phasesCount: 1, terms: {} };
	const funded = buildProviderContractView(c, { amount: 1000, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75 });
	assert.deepEqual(funded.providerTerms, { ratePercent: 12.75, commission: 127.5, net: 872.5, final: true }); assert.equal(funded.currency, 'SAR');
	assert.equal(buildProviderContractView(c, null).providerTerms, null);
	assert.equal(buildProviderContractView(c, { amount: 1000, status: 'HELD', feePolicyVersion: null }).providerTerms, null, 'a legacy escrow has no frozen rate');
});

test('the terms digest changes with the price, the currency and the frozen commission, and is absent before funding', () => {
	const c = { id: 'c1', status: 'S', termsVersion: 1, price: 1000, currency: 'USD', durationDays: 14, phasesCount: 1, terms: {} };
	const e = { id: 'e1', amount: 1000, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75 };
	const base = buildProviderContractView(c, e).termsDigest!; assert.match(base, /^[0-9a-f]{64}$/);
	assert.notEqual(buildProviderContractView({ ...c, price: 1001 }, e).termsDigest, base); assert.notEqual(buildProviderContractView({ ...c, currency: 'SAR' }, e).termsDigest, base);
	assert.notEqual(buildProviderContractView(c, { ...e, providerCommissionRateSnapshot: 10 }).termsDigest, base); assert.notEqual(buildProviderContractView({ ...c, termsVersion: 2 }, e).termsDigest, base);
	assert.equal(buildProviderContractView(c, { ...e }).termsDigest, base, 'stable for the same terms'); assert.equal(buildProviderContractView(c, null).termsDigest, null);
});
