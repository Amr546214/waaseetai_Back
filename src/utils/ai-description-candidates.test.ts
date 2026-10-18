import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_DESCRIPTION_MAX_CHARS, buildDescriptionCandidates, cutAtSentenceBoundary, cleanDescriptionText } from './ai-description-candidates';

const sentence = (i: number) => `هذه جملة وصف كاملة رقم ${i} تشرح جزءاً من العمل المطلوب بوضوح.`;

test('limit is 1500 UTF-16 units (the unit of the textarea maxlength and counter)', () => {
  assert.equal(AI_DESCRIPTION_MAX_CHARS, 1500);
});

test('text of exactly the limit is accepted untouched; one over is cut at a sentence end', () => {
  let text = ''; let i = 0;
  while (text.length < 1400) text += (text ? ' ' : '') + sentence(++i);
  const exact = text + 'ا'.repeat(AI_DESCRIPTION_MAX_CHARS - text.length - 1) + '.';
  assert.equal(exact.length, AI_DESCRIPTION_MAX_CHARS);
  assert.equal(buildDescriptionCandidates(exact).candidates[0].trimmed, false);
  const over = buildDescriptionCandidates(exact + ' ' + sentence(99)).candidates[0];
  assert.ok(over.length <= AI_DESCRIPTION_MAX_CHARS && over.trimmed && over.text.endsWith('.'));
});

test('never cuts mid-sentence: no boundary -> null; a decimal point is not a boundary', () => {
  assert.equal(cutAtSentenceBoundary('كلمة '.repeat(500), 1500), null);
  assert.equal(cutAtSentenceBoundary(('ب'.repeat(200) + ' 3.5 ' + 'ج'.repeat(2000)), 1500), null);
});

test('markdown is cleaned and duplicates are collapsed', () => {
  assert.equal(cleanDescriptionText('## عنوان\n**نص** مهم\n- بند'), 'عنوان\nنص مهم\n• بند');
  const r = buildDescriptionCandidates(`الخيار 1: ${sentence(1)}\nالخيار 2: ${sentence(1)}`);
  assert.equal(r.candidates.length, 1);
});
