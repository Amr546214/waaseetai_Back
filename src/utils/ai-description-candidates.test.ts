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

const body = (n: number) => `هذا نص الوصف الكامل رقم ${n} ويشرح نطاق العمل والمخرجات بوضوح تام.`;

test('real Cloud Run shape: label line + blank line + body (no headings) -> label separated, text label-free', () => {
  const raw = `مباشر وواضح\n\n${body(1)}\n\nاحترافي\n\n${body(2)}\n\nمنظم بالتفاصيل\n\n${body(3)}`;
  const { candidates } = buildDescriptionCandidates(raw);
  assert.deepEqual(candidates.map(c => c.label), ['مباشر وواضح', 'احترافي', 'منظم بالتفاصيل']);
  assert.deepEqual(candidates.map(c => c.text), [body(1), body(2), body(3)]);
  assert.ok(candidates.every(c => c.length === c.text.length && !c.text.includes('مباشر وواضح')));
});

test('headings with an inline style label: «الخيار 1 - مباشر وواضح» and «## الخيار 2: احترافي»', () => {
  const raw = `الخيار 1 - مباشر وواضح\n\n${body(1)}\n\n## الخيار 2: احترافي\n${body(2)}`;
  const { candidates } = buildDescriptionCandidates(raw);
  assert.deepEqual(candidates.map(c => [c.label, c.text]), [['مباشر وواضح', body(1)], ['احترافي', body(2)]]);
});

test('heading then label line then blank line then body', () => {
  const { candidates } = buildDescriptionCandidates(`## الخيار الأول\nمباشر وواضح\n\n${body(1)}\n## الخيار الثاني\nاحترافي\n\n${body(2)}`);
  assert.deepEqual(candidates.map(c => [c.label, c.text]), [['مباشر وواضح', body(1)], ['احترافي', body(2)]]);
});

test('a normal first sentence is never mistaken for a label; the limit counts the label-free text', () => {
  const one = buildDescriptionCandidates(`${body(1)}\n\n${body(2)}`).candidates;
  assert.equal(one.length, 1);
  assert.equal(one[0].label, undefined);
  assert.ok(one[0].text.startsWith('هذا نص'));
});
