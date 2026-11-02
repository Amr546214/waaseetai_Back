import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContentPolicy, checkMultipleContentPolicy } from './content-policy-guard';
for (const text of ['إنشاء متجر خمور', 'بيع نبيذ عبر الإنترنت', 'بيع مخدرات', 'خطة للتهرب الضريبي', 'selling alcohol online']) {
 test(`blocks prohibited service: ${text}`, () => assert.equal(checkContentPolicy(text).blocked, true));
}
for (const text of ['', 'تطوير متجر ملابس', 'استشارة امتثال ضريبي', 'تصميم صيدلية مرخصة']) {
 test(`allows ordinary professional work: ${text}`, () => assert.equal(checkContentPolicy(text).blocked, false));
}
test('normalizes Arabic marks and combines fields', () => {
 assert.equal(checkMultipleContentPolicy(['متجر', 'خُمُور']).category, 'alcohol');
});
