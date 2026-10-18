import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRewrite, checkRewriteOutput, checkRewritePreview, hasEnoughDescriptionToRewrite, REWRITE_MAX_CHARS, REWRITE_PREVIEW_MAX_CHARS } from './description-rewrite-guard';

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

test('selected output: empty or over-limit descriptions are rejected without truncating their content', () => {
  assert.deepEqual(checkRewriteOutput(DRAFT, '  \n '), { ok: false, reason: 'empty' });
  assert.deepEqual(checkRewriteOutput(DRAFT, 'ا'.repeat(REWRITE_MAX_CHARS)), { ok: true, text: 'ا'.repeat(REWRITE_MAX_CHARS) });
  assert.deepEqual(checkRewriteOutput(DRAFT, 'ا'.repeat(REWRITE_MAX_CHARS + 1)), { ok: false, reason: 'too_long' });
});

test('preview: preserve all alternative drafts and final facts beyond the selected-description limit', () => {
  const text = `مقدمة\n### الخيار الأول\n${'أ'.repeat(1800)}\n### الخيار الثاني\n${'ب'.repeat(1800)}\n### الخيار الثالث\n${'ج'.repeat(1800)}\nموعد التسليم 15/10/2026 والميزانية 4500 دولار.`;
  assert.deepEqual(checkRewritePreview(DRAFT, text), { ok: true, text });
  assert.deepEqual(checkRewritePreview(DRAFT, 'ا'.repeat(REWRITE_PREVIEW_MAX_CHARS)), { ok: true, text: 'ا'.repeat(REWRITE_PREVIEW_MAX_CHARS) });
  assert.deepEqual(checkRewritePreview(DRAFT, 'ا'.repeat(REWRITE_PREVIEW_MAX_CHARS + 1)), { ok: false, reason: 'too_long' });
  assert.deepEqual(checkRewritePreview(DRAFT, ' \n '), { ok: false, reason: 'empty' });
});
