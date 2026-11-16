import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The identity step the owners really use (identity gate) must start the advisory ID field check the reviewers read in the KYC panel (flag IDENTITY_AUTO_CHECK).
test('saveIdentity starts the advisory field check after saving', () => {
  const src = readFileSync(join(process.cwd(), 'src/services/identity-gate.service.ts'), 'utf8');
  const save = src.slice(src.indexOf('async saveIdentity('));
  assert.match(save, /identityFieldCheckService\.triggerSafe\(userId, party\)/);
  assert.ok(save.indexOf('triggerSafe') > save.indexOf('prisma.$transaction'), 'the check starts after the transaction that stores the data');
});
