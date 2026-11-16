import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// The back side of the identity document is optional for every kind: the review relies on the front side.
test('missingIdentityItems never lists the back side', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  const { missingIdentityItems } = await import(`./identity-gate.service.ts?fixture=${Date.now()}`);
  const full = { idDocumentType: 'NATIONAL_ID', idIssuingCountry: 'EG', idNumber: '30408012203296', frontIdUrl: 'private:front' };
  assert.deepEqual(missingIdentityItems(full), []);
  assert.deepEqual(missingIdentityItems({ ...full, frontIdUrl: null }), ['frontId']);
  assert.ok(!missingIdentityItems({ ...full, idDocumentType: 'DRIVING_LICENCE' }).includes('backId'));
});
