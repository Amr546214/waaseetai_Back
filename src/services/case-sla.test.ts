import assert from 'node:assert/strict';
import { test } from 'node:test';

test('SLA preflight validates UTC settings and target permissions without writes; a sweep skips an ineligible target', async t => {
  const accessChecks: [string, string[]][] = [];
  const audited: any[] = [];
  const sql: string[] = [];
  const prisma = {
    user: { findUnique: async () => ({ firstName: 'QA', lastName: 'Staff' }) },
    $transaction: async (run: (tx: any) => Promise<unknown>) => run({
      $queryRaw: async (query: { sql: string }) => {
        sql.push(query.sql);
        return audited.length ? [] : [{ id: 'ticket-qa' }];
      },
      accountAuditLog: { createMany: async ({ data }: any) => { audited.push(...data); return { count: data.length }; } },
    }),
  };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('./admin-access.service', { namedExports: { assigneeHolds: async (id: string, permissions: string[]) => {
    accessChecks.push([id, permissions]);
    return id === 'support-eligible';
  } } });
  const { checkCaseSlaReadiness, runCaseSlaOnce } = await import('./case-sla.service');
  const from = '2026-11-08T08:00:00Z';
  const now = new Date('2026-11-08T12:00:00Z');
  const base = { CASE_SLA_ENABLED: 'true', CASE_SLA_FROM: from, SUPPORT_SLA_TARGET_ADMIN_ID: 'support-eligible' };
  assert.deepEqual(await checkCaseSlaReadiness({}, now), { state: 'disabled' });
  for (const invalid of ['2026-11-08T08:00:00', '2026-02-30T08:00:00Z', '2026-11-08T08:00:00+02:00']) {
    assert.deepEqual(await checkCaseSlaReadiness({ ...base, CASE_SLA_FROM: invalid }, now), { state: 'invalid', setting: 'CASE_SLA_FROM' });
  }
  assert.deepEqual(await checkCaseSlaReadiness({ ...base, SUPPORT_SLA_FIRST_REPLY_HOURS: '48,24,8,0' }, now), { state: 'invalid', setting: 'SUPPORT_SLA_FIRST_REPLY_HOURS' });
  assert.equal((await checkCaseSlaReadiness({ ...base, SUPPORT_SLA_TARGET_ADMIN_ID: ' ' }, now)).state, 'invalid');
  assert.deepEqual(accessChecks, []);
  assert.equal((await checkCaseSlaReadiness(base, new Date('2026-11-08T07:59:59Z'))).state, 'scheduled');
  assert.deepEqual(await checkCaseSlaReadiness(base, now), { state: 'ready', from: '2026-11-08T08:00:00.000Z', hours: [48, 24, 8, 2], support: 'eligible', disputes: 'not-configured' });
  const both = { ...base, DISPUTE_SLA_TARGET_ADMIN_ID: 'dispute-ineligible' };
  assert.equal((await checkCaseSlaReadiness(both, now)).state, 'ineligible');
  assert.deepEqual(accessChecks.at(-2), ['support-eligible', ['support.review', 'support.reply']]);
  assert.deepEqual(accessChecks.at(-1), ['dispute-ineligible', ['disputes.view', 'disputes.resolve']]);
  assert.deepEqual(sql, []);
  assert.deepEqual(audited, []);

  const before = Object.fromEntries(Object.keys(both).map(key => [key, process.env[key]]));
  Object.assign(process.env, both);
  try {
    assert.deepEqual(await runCaseSlaOnce(new Date('2026-11-08T07:59:59Z')), { tickets: 0, disputes: 0 });
    assert.deepEqual(await runCaseSlaOnce(now), { tickets: 1, disputes: 0 });
    assert.match(sql[0], /FOR UPDATE OF t SKIP LOCKED/);
    assert.equal(audited[0].userId, 'support-eligible');
    assert.equal(audited[0].context.entityId, 'ticket-qa');
    assert.deepEqual(await runCaseSlaOnce(now), { tickets: 0, disputes: 0 });
    assert.equal(audited.length, 1);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
