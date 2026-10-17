import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditExistingModels, auditOptions } from './audit-existing-models';

const id = '3ed91ae5-074c-48d2-a635-2b14092ae0af';

test('retroactive audit defaults to a read-only preview and selects unassessed published listings', async () => {
  let query: any;
  let called = false;
  const db = { serviceCatalog: { findMany: async (value: any) => {
    query = value;
    return [{ id, title: 'خدمة', status: 'PUBLISHED', specialtyId: 'specialty-1' }];
  } } };
  const result = await auditExistingModels(db, async () => { called = true; throw new Error('must never call'); }, ['--id', id], () => {});
  assert.equal(called, false);
  assert.equal(query.where.id, id);
  assert.equal(query.where.aiAuditScore, null);
  assert.ok(query.where.status.in.includes('PUBLISHED'));
  assert.ok(query.where.status.in.includes('APPROVED'));
  assert.equal(query.take, 25);
  assert.deepEqual(result, { selected: 1, audited: 0, skipped: 0, failed: 0 });
});

test('explicit execution uses current audit outcomes, skips missing categories, and continues after failure', async () => {
  const models = [
    { id: 'a', specialtyId: 's' }, { id: 'b', specialtyId: null },
    { id: 'c', specialtyId: 's' }, { id: 'd', specialtyId: 's' },
  ];
  const calls: string[] = [];
  const logs: unknown[] = [];
  const result = await auditExistingModels({ serviceCatalog: { findMany: async () => models } }, async (serviceId) => {
    calls.push(serviceId);
    if (serviceId === 'c') throw Object.assign(new Error('secret provider details'), { code: 'TIMEOUT' });
    return { outcome: 'audited', serviceId, score: 76, isApproved: null };
  }, ['--execute', '--limit', '10'], value => logs.push(value));
  assert.deepEqual(calls, ['a', 'c', 'd']);
  assert.deepEqual(result, { selected: 4, audited: 2, skipped: 1, failed: 1 });
  assert.ok(!JSON.stringify(logs).includes('secret provider'));
});

test('retroactive audit rejects ambiguous mode, invalid targets, and unbounded batches', () => {
  for (const args of [['--execute', '--dry-run'], ['--id'], ['--id', 'bad'], ['--limit', '0'], ['--limit', '101'], ['--limit', '1.5'], ['--unknown']]) {
    assert.throws(() => auditOptions(args));
  }
});
