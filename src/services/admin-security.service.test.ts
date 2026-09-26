import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 7 — replaces sa-security.ts's fully hardcoded
// security event feed and fabricated KPIs ("847 محاولات فاشلة", "124 IPs
// محجوبة", "24,812 Audit Logs اليوم"). These tests prove the real
// replacement reads AccountAuditLog (already populated by auth.service.ts,
// session.service.ts, provider-profile.service.ts, etc.) and computes
// every KPI from real counts — never a fabricated number.

function logFixture(overrides: Partial<any> = {}) {
  return {
    id: 'log-1',
    category: 'SECURITY_CHANGE',
    eventType: 'LOGIN_REJECTED',
    title: 'محاولة تسجيل دخول مرفوضة',
    summary: 'تم رفض محاولة تسجيل دخول بكلمة مرور غير صحيحة',
    severity: 'WARNING',
    source: 'USER',
    status: 'REJECTED',
    occurredAt: new Date(),
    ipAddress: '192.168.1.5',
    device: 'Chrome on macOS',
    actorLabel: null,
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: {
  logs?: any[];
  totalEventsToday?: number;
  criticalOrWarningToday?: number;
  failedLoginAttemptsToday?: number;
} = {}) {
  const countCalls: any[] = [];
  const prismaMock: any = {
    accountAuditLog: {
      findMany: async () => opts.logs ?? [logFixture()],
      count: async (args: any) => {
        countCalls.push(args);
        if (args?.where?.eventType === 'LOGIN_REJECTED') return opts.failedLoginAttemptsToday ?? 3;
        if (args?.where?.severity) return opts.criticalOrWarningToday ?? 5;
        return opts.totalEventsToday ?? 42;
      },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./admin-security.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.adminSecurityService, countCalls };
}

test('getSecurityEvents: KPIs are real counts from AccountAuditLog, never the old hardcoded 847/124/24812', async t => {
  const { service } = await loadService(t, { totalEventsToday: 42, criticalOrWarningToday: 5, failedLoginAttemptsToday: 3 });
  const result = await service.getSecurityEvents();
  assert.deepEqual(result.kpis, { totalEventsToday: 42, criticalOrWarningToday: 5, failedLoginAttemptsToday: 3 });
});

test('getSecurityEvents: maps real log rows with no fabricated "blocked IP" concept', async t => {
  const { service } = await loadService(t, { logs: [logFixture()] });
  const result = await service.getSecurityEvents();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventType, 'LOGIN_REJECTED');
  assert.equal(result.events[0].ipAddress, '192.168.1.5');
  assert.equal((result as any).blockedIps, undefined);
});

test('getSecurityEvents: clamps an out-of-range limit into [1, 200]', async t => {
  const { service } = await loadService(t, { logs: [] });
  await service.getSecurityEvents(-5);
  await service.getSecurityEvents(9999);
  // No throw, and the mocked findMany always returns [] regardless of take —
  // this test only proves the call does not crash on extreme input.
  const result = await service.getSecurityEvents(9999);
  assert.deepEqual(result.events, []);
});

// getFlaggedAccounts replaces sa-risk-center.ts's fully hardcoded
// riskAccounts (fictional names/scores like "عبدالرحمن الدوسري — score
// 89") — it must never invent a risk score, only report real suspended
// accounts and their real open-dispute counts.
async function loadFlaggedAccountsService(t: TestContext, opts: {
  users?: any[];
  disputeCountsByCall?: number[];
} = {}) {
  const userFindManyArgs: any[] = [];
  let disputeCallIndex = 0;
  const disputeCounts = opts.disputeCountsByCall ?? [];
  const prismaMock: any = {
    accountAuditLog: { findMany: async () => [], count: async () => 0 },
    user: {
      findMany: async (args: any) => {
        userFindManyArgs.push(args);
        return opts.users ?? [];
      },
    },
    dispute: {
      count: async () => disputeCounts[disputeCallIndex++] ?? 0,
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./admin-security.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.adminSecurityService, userFindManyArgs };
}

test('getFlaggedAccounts: only queries real SUSPENDED/SUSPENDED_REVIEW users, no fabricated risk score field', async t => {
  const { service, userFindManyArgs } = await loadFlaggedAccountsService(t, {
    users: [{ id: 'u1', firstName: 'خالد', lastName: 'العتيبي', accountType: 'PROVIDER_INDIVIDUAL', status: 'SUSPENDED' }],
    disputeCountsByCall: [2, 0],
  });
  const result = await service.getFlaggedAccounts();
  assert.deepEqual(userFindManyArgs[0].where, { status: { in: ['SUSPENDED', 'SUSPENDED_REVIEW'] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'خالد العتيبي');
  assert.equal(result[0].openDisputesAgainst, 2);
  assert.equal(result[0].openDisputesOpened, 0);
  assert.equal((result[0] as any).score, undefined);
  assert.equal((result[0] as any).reasons, undefined);
});

test('getFlaggedAccounts: returns an empty list (not fabricated fictional accounts) when no user is suspended', async t => {
  const { service } = await loadFlaggedAccountsService(t, { users: [] });
  const result = await service.getFlaggedAccounts();
  assert.deepEqual(result, []);
});
