import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Batch 6 — source-level wiring check (same pattern as
// provider-profile.routes.test.ts, which this codebase's test suite uses in
// place of booting a full Express app + supertest). Locks in that the new
// assigned-employee route carries both the role-level and strict-accountType
// guards, so a future edit can't silently drop either one.

const source = fs.readFileSync(path.join(__dirname, 'client-project-amendments.routes.ts'), 'utf8');

test('PUT /:id/assigned-employee carries both authorize(CLIENT_COMPANY) and requireClientCompanyAccount', () => {
  const start = source.indexOf("router.put(\n\t'/:id/assigned-employee'");
  assert.ok(start >= 0, 'expected the assigned-employee PUT route registration to exist');
  const block = source.slice(start, start + 300);
  assert.ok(block.includes('authorize(AccountType.CLIENT_COMPANY)'), 'missing authorize(CLIENT_COMPANY) guard');
  assert.ok(block.includes('requireClientCompanyAccount'), 'missing requireClientCompanyAccount strict guard');
  assert.ok(block.includes('setProjectAssignedEmployee'), 'missing the real controller handler');
});

test('the amendments routes (unrelated Batch) remain ungated by the new company-only guard', () => {
  const amendmentsLine = source.split('\n').find(l => l.includes("router.post('/:projectId/amendments'"));
  assert.ok(amendmentsLine);
  assert.ok(!amendmentsLine.includes('requireClientCompanyAccount'), 'amendments route must stay open to both CLIENT_INDIVIDUAL and CLIENT_COMPANY');
});
