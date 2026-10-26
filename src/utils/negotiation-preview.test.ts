import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiationPreviewText, NEG_PREFIX } from './offer-negotiation';

const card = (o: object) => NEG_PREFIX + JSON.stringify(o);

test('a client negotiation request previews as a sentence, never as raw WS_NEGOTIATION text', () => {
	const t = negotiationPreviewText(card({ isNegotiation: true, negType: 'price', negTypeName: 'تعديل السعر', price: '45', duration: '6', notes: 'x', status: 'pending' }), false)!;
	assert.equal(t, 'طلب تفاوض على العرض — 45.00 USD');
	assert.ok(!/WS_NEGOTIATION|isNegotiation|negTypeName|[{}]/.test(t));
});

test('provider counter / reject and client accept / decline each have their own wording', () => {
	assert.equal(negotiationPreviewText(card({ kind: 'PROVIDER_COUNTER', offerId: 'o1', price: 50, deliveryDays: 6 }), true), 'عرض مضاد من مقدم الخدمة — 50.00 USD');
	assert.equal(negotiationPreviewText(card({ kind: 'PROVIDER_REJECT', offerId: 'o1' }), true), 'رفض مقدم الخدمة طلب التفاوض');
	assert.equal(negotiationPreviewText(card({ kind: 'CLIENT_ACCEPT_COUNTER', offerId: 'o1' }), false), 'قبل العميل العرض المضاد');
	assert.equal(negotiationPreviewText(card({ kind: 'CLIENT_DECLINE_COUNTER', offerId: 'o1' }), false), 'رفض العميل العرض المضاد');
});

test('a price that is not a clear number is not shown; unreadable JSON still never leaks', () => {
	assert.equal(negotiationPreviewText(card({ isNegotiation: true, price: 'حوالي 4000' }), false), 'طلب تفاوض على العرض');
	assert.equal(negotiationPreviewText(NEG_PREFIX + '{not json', false), 'رسالة تفاوض');
});

test('ordinary messages are not touched (null = keep the original text)', () => {
	assert.equal(negotiationPreviewText('مرحبا', false), null);
	assert.equal(negotiationPreviewText(null, true), null);
});

test('chat.service uses it for the conversation list preview', async () => {
	const src = (await import('node:fs')).readFileSync(new URL('../services/chat.service.ts', import.meta.url), 'utf8');
	assert.match(src, /negotiationPreviewText\(lastMsgObj\.content, lastMsgObj\.senderId === conv\.providerId, conv\.project\?\.currency\)/);
});
