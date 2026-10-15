import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amendmentEventKey, amendmentEventText } from './amendment-events';

const base = { id: 'am1', contractId: 'c1', projectId: 'p1', title: 'مدة', requestedByRole: 'CLIENT', type: 'DURATION', description: null, budgetDelta: null, durationDeltaDays: 2 };

test('created: states the real change against the contract (duration 4 -> 6)', () => {
  assert.equal(amendmentEventText('created', base, { price: 100, durationDays: 4 }), 'طلب العميل تعديل المدة من 4 إلى 6 أيام — «مدة»');
  assert.match(amendmentEventText('created', { ...base, requestedByRole: 'PROVIDER', type: 'BUDGET', durationDeltaDays: null, budgetDelta: 50 }, { price: 200, durationDays: 4 })!, /طلب مقدم الخدمة تعديل الميزانية من 200 إلى 250 \$/);
});

test('applied is never produced for a row the transaction did not apply', () => {
  assert.equal(amendmentEventText('applied', { ...base, appliedAt: null }), null);
  const t = amendmentEventText('applied', { ...base, appliedAt: new Date(), durationBefore: 4, durationAfter: 6 });
  assert.match(t!, /طُبّق التعديل على العقد: المدة من 4 إلى 6 أيام/);
});

test('decision events name the answering party and carry no code', () => {
  assert.match(amendmentEventText('accepted', base)!, /^وافق مقدم الخدمة/);
  assert.match(amendmentEventText('rejected', { ...base, requestedByRole: 'PROVIDER' })!, /^رفض العميل/);
  assert.match(amendmentEventText('cancelled', base)!, /^ألغى العميل/);
  assert.doesNotMatch(amendmentEventText('funding_authorised', { ...base, fundingAuthorizedAmount: 50 })!, /\d{6}/);
});

test('event keys are deterministic per amendment and kind; a re-authorisation is a different state change', () => {
  assert.equal(amendmentEventKey('created', base), 'amendment:am1:created');
  assert.equal(amendmentEventKey('created', base), amendmentEventKey('created', base));
  const t1 = new Date(1000), t2 = new Date(2000);
  assert.notEqual(amendmentEventKey('funding_authorised', { ...base, fundingAuthorizedAt: t1 }), amendmentEventKey('funding_authorised', { ...base, fundingAuthorizedAt: t2 }));
});
