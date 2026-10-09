import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Provider AI claims (Batch C2): rule-based output never carries a made-up placeholder or an "AI" claim.
const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('explore-requests: no placeholder budget range when the request has none', () => {
  assert.ok(!read('./explore-requests.service.ts').includes('1,500 - 4,000'));
});
test('ai-matching-engine (rules): no "موثق بالذكاء" reason', () => {
  assert.ok(!read('./ai-matching-engine.service.ts').includes('موثق بالذكاء'));
});
test('provider statistics: aiRating is no longer a hardcoded 0', () => {
  assert.ok(!/const aiRating = 0/.test(read('../controllers/provider.controller.ts')));
});
test('public profile metrics: no all-zero placeholder object', () => {
  assert.ok(!read('./provider-profile.service.ts').includes('ZERO_AI_METRICS'));
});
