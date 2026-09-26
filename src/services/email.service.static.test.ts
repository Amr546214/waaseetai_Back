import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Implementation Batch 6 — the accreditation-completion email template
// falsely branded a now-Gemini-backed feature as "GPT-4o" (a plain static
// text assertion over the source, matching the frontend's equivalent
// g16-marketing-ai-claims.static.spec.ts pattern for the same class of bug).

test('email.service.ts: accreditation-completion email no longer brands the (Gemini-backed) evaluation as GPT-4o', () => {
  const source = fs.readFileSync(path.join(__dirname, 'email.service.ts'), 'utf8');
  assert.doesNotMatch(source, /GPT-4o/);
  assert.doesNotMatch(source, /OpenAI/);
});
