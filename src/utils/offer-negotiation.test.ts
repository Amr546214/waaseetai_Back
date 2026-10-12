import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPlainNumber, parseNegotiationMessage, isClearRequest, readNegotiationEntries, deriveNegotiationState, buildProviderEntry, NEG_PREFIX } from './offer-negotiation';

const client = (o: object) => NEG_PREFIX + JSON.stringify({ isNegotiation: true, status: 'PENDING', ...o });
const row = (id: string, senderId: string, content: string, sec: number) => ({ id, senderId, content, createdAt: new Date(2026, 0, 1, 0, 0, sec) });

test('readPlainNumber accepts only whole plain numbers', () => {
	assert.equal(readPlainNumber('4000'), 4000);
	assert.equal(readPlainNumber('4,000'), 4000);
	assert.equal(readPlainNumber('4000 $'), 4000);
	assert.equal(readPlainNumber('4000.50'), 4000.5);
	assert.equal(readPlainNumber('30 يوم'), 30);
	for (const bad of ['حوالي 4000', '3000-4000', '', '   ', '0', '-5', 'abc', '4000 أو أقل', '1e3', '12.345', null, undefined, {}, NaN, Infinity]) assert.equal(readPlainNumber(bad as any), null, String(bad));
});

test('a client card is read from its JSON; unreadable JSON and non-negotiation text are not entries', () => {
	const p = parseNegotiationMessage(client({ negType: 'price', price: '3,500', notes: 'خصم؟' }), false)!;
	assert.deepEqual({ kind: p.kind, price: p.price, days: p.deliveryDays, notes: p.notes }, { kind: 'CLIENT_REQUEST', price: 3500, days: null, notes: 'خصم؟' });
	assert.equal(isClearRequest(p), true);
	assert.equal(parseNegotiationMessage(NEG_PREFIX + '{oops', false), null);
	assert.equal(parseNegotiationMessage('مرحبا', false), null);
	assert.equal(parseNegotiationMessage(null, false), null);
});

test('free-text client negotiation is NOT a clear request', () => {
	for (const o of [{ price: 'حوالي 3000' }, { price: '' }, { notes: 'أريد خصمًا' }, { price: 'قابل للتفاوض', duration: 'مرن' }]) assert.equal(isClearRequest(parseNegotiationMessage(client(o), false)!), false);
});

test('a provider message only counts when it is a structured provider kind', () => {
	assert.equal(parseNegotiationMessage(client({ price: '1000' }), true), null);
	const c = parseNegotiationMessage(buildProviderEntry('PROVIDER_COUNTER', { offerId: 'o1', price: 900, deliveryDays: 10 }), true)!;
	assert.deepEqual({ kind: c.kind, price: c.price, days: c.deliveryDays, offerId: c.offerId }, { kind: 'PROVIDER_COUNTER', price: 900, days: 10, offerId: 'o1' });
});

test('a provider entry never carries a PENDING status (the other side draws no local accept/reject buttons for it)', () => {
	for (const kind of ['PROVIDER_COUNTER', 'PROVIDER_REJECT'] as const) {
		const json = JSON.parse(buildProviderEntry(kind, { offerId: 'o1', price: 1, deliveryDays: 1 }).slice(NEG_PREFIX.length));
		assert.notEqual(json.status, 'PENDING');
		assert.equal(json.isNegotiation, true);
	}
});

test('state: the NEWEST entry decides — counter pending, open client request, or nothing', () => {
	const e = (rows: any[]) => deriveNegotiationState(readNegotiationEntries(rows, 'prov'), 'o1');
	const req = row('m1', 'cli', client({ price: '800' }), 1);
	const counter = row('m2', 'prov', buildProviderEntry('PROVIDER_COUNTER', { offerId: 'o1', price: 900, deliveryDays: 5 }), 2);
	const reject = row('m3', 'prov', buildProviderEntry('PROVIDER_REJECT', { offerId: 'o1', replyToMessageId: 'm1' }), 3);
	const req2 = row('m4', 'cli', client({ price: '700' }), 4);
	assert.deepEqual([e([]).counterPending, e([]).openRequest], [false, null]);
	assert.equal(e([req]).openRequest?.messageId, 'm1');
	assert.equal(e([req, counter]).counterPending, true);
	assert.equal(e([req, counter]).openRequest, null);
	assert.equal(e([req, counter, req2]).counterPending, false); // the client answered with a new request
	assert.equal(e([req, counter, req2]).openRequest?.messageId, 'm4');
	assert.equal(e([req, reject]).openRequest, null); // answered
	assert.equal(e([req, reject]).counterPending, false);
});
