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

test('output guard: a faithful rewrite passes', () => {
  const r = checkRewriteOutput(DRAFT, 'أحتاج إلى متجر إلكتروني لبيع الملابس يدعم الدفع عبر الإنترنت وإدارة المخزون، مع لوحة تحكم لمتابعة الطلبات.');
  assert.equal(r.ok, true);
});

test('output guard: numbers the client wrote are kept, new ones are rejected (Arabic-Indic digits count too)', () => {
  const src = 'أحتاج موقعًا تعريفيًا لشركتي خلال 30 يومًا بميزانية 2000 دولار مع صفحة تواصل ومعرض أعمال';
  assert.equal(checkRewriteOutput(src, 'أحتاج إلى موقع تعريفي لشركتي خلال ٣٠ يومًا بميزانية 2000 دولار، مع صفحة تواصل ومعرض أعمال.').ok, true);
  assert.deepEqual(checkRewriteOutput(src, 'أحتاج إلى موقع تعريفي لشركتي خلال 45 يومًا بميزانية 2000 دولار، مع صفحة تواصل ومعرض أعمال.'), { ok: false, reason: 'invented-numbers' });
});

test('output guard: chatter, markdown, empty and off-topic replies are rejected', () => {
  assert.deepEqual(checkRewriteOutput(DRAFT, 'يبدو أنك قمت بنسخ نص. أحتاج متجرًا إلكترونيًا لبيع الملابس.'), { ok: false, reason: 'meta' });
  assert.deepEqual(checkRewriteOutput(DRAFT, 'إليك الصياغة: أحتاج متجرًا إلكترونيًا لبيع الملابس.'), { ok: false, reason: 'meta' });
  assert.deepEqual(checkRewriteOutput(DRAFT, '***أحتاج متجرًا إلكترونيًا*** لبيع الملابس يدعم الدفع وإدارة المخزون'), { ok: false, reason: 'markdown' });
  assert.deepEqual(checkRewriteOutput(DRAFT, '## أحتاج متجرًا إلكترونيًا لبيع الملابس'), { ok: false, reason: 'markdown' });
  assert.deepEqual(checkRewriteOutput(DRAFT, ' '), { ok: false, reason: 'empty' });
  assert.equal(checkRewriteOutput(DRAFT, 'نبحث عن شركة برمجيات متخصصة لتنفيذ تطبيق جوال متكامل لخدمات التوصيل السريع مع نظام تتبع ودعم فني.').ok, false);
});

test('output guard: a phrase the client wrote themselves is not treated as AI chatter', () => {
  const src = 'بالطبع نحتاج تصميم هوية بصرية كاملة لشركتنا الناشئة تشمل الشعار والألوان والخطوط';
  assert.equal(checkRewriteOutput(src, 'بالطبع نحتاج إلى تصميم هوية بصرية كاملة لشركتنا الناشئة، تشمل الشعار والألوان والخطوط.').ok, true);
});
