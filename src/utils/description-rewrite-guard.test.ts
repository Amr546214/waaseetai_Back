import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRewrite, checkRewriteOutput, hasEnoughDescriptionToRewrite } from './description-rewrite-guard';

const DRAFT = 'أحتاج متجرًا إلكترونيًا لبيع الملابس يدعم الدفع عبر الإنترنت وإدارة المخزون ولوحة تحكم للطلبات';

test('input guard: title and description must both be real', () => {
  assert.equal(canRewrite('تطوير متجر إلكتروني', DRAFT), true);
  assert.equal(canRewrite('', DRAFT), false);
  assert.equal(canRewrite('مشروع', DRAFT), false);
  assert.equal(canRewrite('تطوير متجر إلكتروني', ''), false);
  assert.equal(hasEnoughDescriptionToRewrite('متجر ملابس'), false);
  assert.equal(hasEnoughDescriptionToRewrite('كلمة كلمة كلمة كلمة كلمة'), false);
});

test('output: the reply is accepted as written (assistant phrasing, markdown, new numbers are not rejected)', () => {
  for (const reply of ['يبدو أنك نسخت نصا. أحتاج متجرا.', 'إليك الصياغة: ## عنوان\n- نقطة', '***نص*** بميزانية 5000 دولار خلال 30 يوما']) {
    assert.deepEqual(checkRewriteOutput(DRAFT, reply), { ok: true, text: reply });
  }
});

test('output: only an empty reply is refused; a long one is cut to 2000', () => {
  assert.deepEqual(checkRewriteOutput(DRAFT, '  \n '), { ok: false, reason: 'empty' });
  const r = checkRewriteOutput(DRAFT, 'ا'.repeat(2600));
  assert.equal(r.ok && r.text.length, 2000);
});
