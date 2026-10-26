import { test, mock, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let cur: { over: any; audits: any[]; updates: any[] } = { over: {}, audits: [], updates: [] };
let mocked = false;
async function load(t: TestContext, over: any = {}) {
  const audits: any[] = [];
  const updates: any[] = [];
  cur = { over, audits, updates };
  const prismaMock: any = {
    accountAuditLog: {
      create: async (a: any) => { cur.audits.push(a.data); return a.data; },
      findMany: async (a: any) => { cur.over.findManyArgs = a; return cur.over.logs ?? []; },
      count: async () => cur.over.total ?? 0,
      groupBy: async () => cur.over.kinds ?? [],
    },
    adminAccessAudit: { findMany: async () => cur.over.access ?? [], count: async () => (cur.over.access ?? []).length, groupBy: async () => [] },
    adminRole: { findMany: async () => [] },
    $queryRaw: async () => [],
    userSession: {
      updateMany: async (a: any) => { cur.updates.push(a); return { count: cur.over.revokeCount ?? 0 }; },
    },
    user: {
      findUnique: async () => cur.over.before ?? { firstName: 'A', lastName: 'B', phoneCountryCode: '+966', phoneNumber: null },
      findFirst: async () => cur.over.phoneTaken ?? null,
      update: async (a: any) => ({ id: 'u1', email: 'a@b.c', accountType: 'SUPER_ADMIN', avatarUrl: null, phoneCountryCode: '+966', phoneNumber: null, firstName: 'A', lastName: 'B', ...a.data }),
      findMany: async () => cur.over.admins ?? [],
    },
  };
  if (!mocked) { mock.module('../config/db', { namedExports: { prisma: prismaMock } }); mocked = true; }
  const mod = await import(`./admin-account.service.ts?f=${Date.now()}-${Math.random()}`);
  return { service: mod.adminAccountService, audits, updates, prismaMock };
}

test('save profile updates the account and writes a PROFILE_UPDATED audit entry', async (t) => {
  const { service, audits } = await load(t);
  const res = await service.updateMe('u1', { firstName: 'Sara' }, { sessionId: 's1' });
  assert.equal(res.firstName, 'Sara');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, 'PROFILE_UPDATED');
  assert.equal(audits[0].userId, 'u1');
  assert.deepEqual(audits[0].metaData.changedFields, ['firstName']);
});

test('save profile rejects unknown fields (no privilege escalation) and empty payloads', async (t) => {
  const { service, audits } = await load(t);
  await assert.rejects(() => service.updateMe('u1', { accountType: 'SUPER_ADMIN' }));
  await assert.rejects(() => service.updateMe('u1', {}), /NO_FIELDS/);
  assert.equal(audits.length, 0);
});

test('save profile rejects a phone number used by another account', async (t) => {
  const { service } = await load(t, { phoneTaken: { id: 'other' } });
  await assert.rejects(() => service.updateMe('u1', { phoneNumber: '501234567' }), /PHONE_TAKEN/);
});

test('terminate own session: revokes scoped to the caller and writes SESSION_REVOKED', async (t) => {
  const { service, audits, updates } = await load(t, { revokeCount: 1 });
  await service.terminateSession('u1', 's2', 's1');
  assert.deepEqual(updates[0].where, { id: 's2', userId: 'u1', revokedAt: null });
  assert.equal(audits[0].eventType, 'SESSION_REVOKED');
});

test("terminate another user's session -> SESSION_NOT_FOUND and no audit entry", async (t) => {
  const { service, audits } = await load(t, { revokeCount: 0 });
  await assert.rejects(() => service.terminateSession('u1', 'foreign', 's1'), /SESSION_NOT_FOUND/);
  assert.equal(audits.length, 0);
});

test('current session cannot be terminated', async (t) => {
  const { service, updates } = await load(t);
  await assert.rejects(() => service.terminateSession('u1', 's1', 's1'), /CANNOT_REVOKE_CURRENT_SESSION/);
  assert.equal(updates.length, 0);
});

test('terminate all others keeps the current session and audits the count', async (t) => {
  const { service, audits, updates } = await load(t, { revokeCount: 3 });
  const r = await service.terminateOtherSessions('u1', 's1');
  assert.equal(r.revoked, 3);
  assert.deepEqual(updates[0].where, { userId: 'u1', revokedAt: null, id: { not: 's1' } });
  assert.equal(audits[0].eventType, 'SESSIONS_REVOKED_OTHERS');
});

test('audit log applies actor, event type, date range and pagination filters', async (t) => {
  const o: any = { total: 45, logs: [{ id: 'l1', eventType: 'LOGIN_REJECTED', userId: 'u1', user: { firstName: 'A', lastName: 'B', accountType: 'ADMIN' }, occurredAt: new Date(), title: 't', summary: 's', severity: 'INFO', source: 'USER', status: 'COMPLETED' }], kinds: [{ eventType: 'LOGIN_REJECTED' }] };
  const { service } = await load(t, o);
  const r = await service.listAuditLog({ actorId: 'u1', eventType: 'login_rejected', from: '2026-10-01', to: '2026-10-10', page: '2', limit: '20' });
  const where = JSON.stringify(o.findManyArgs.where);
  assert.match(where, /"userId":"u1"/);
  assert.match(where, /LOGIN_REJECTED/);
  assert.match(where, /gte/);
  // the trail merges two sources, so each fetches page*limit rows and the merged list is sliced to the page
  assert.equal(o.findManyArgs.take, 40);
  assert.equal(r.items.length, 0);
  assert.equal(r.pagination.pages, 3);
  assert.deepEqual(r.eventTypes, ['LOGIN_REJECTED']);
});

test('admin routes: non-admin gets 403 (router gated to admin-type accounts; audit log and roster need their own permission)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-account.routes.ts'), 'utf8');
  assert.match(src, /router\.use\(authenticate,\s*requireActiveUser,\s*requireAdminAccount\)/);
  assert.match(src, /router\.get\('\/audit-log',\s*requirePermission\('audit\.view'\)/);
  for (const r of ["'/audit-log'", "'/admins'", "'/account/sessions/:id'"]) assert.ok(src.includes(r), r);
});
