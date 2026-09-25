import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specialtyService } from './specialty.service';

// Final AI cleanup batch: executeAiAudit() previously fabricated a fixed
// { aiScore: 89.5, feasibilityScore: 92.0, clarityScore: 86.0,
// ownershipCredibility: 91.0 } result (plus a canned aiFeedback object) on
// every call, with no real analysis, and persisted it as if it were a real
// evaluation. Removed entirely along with its controller/route (the real
// wizard flow only ever called aiEvaluate(), never this dead HTTP twin).
// This guards against it silently reappearing.
test('specialtyService: the removed fake executeAiAudit method must never reappear', () => {
  assert.equal((specialtyService as any).executeAiAudit, undefined);
});
