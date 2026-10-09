import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { specialtyReviewDecisionSchema } from '../dtos/accreditation.dto';

async function load(t: TestContext, o: { row?: any; count?: number; approvedCount?: number; profileId?: string | null } = {}) {
  const updates: any[] = [];
  const userUpdates: any[] = [];
  const counts: any[] = [];
  const logs: any[] = [];
  const row = 'row' in o ? o.row : { id: 'ps1', status: 'UNDER_AI_REVIEW', providerProfile: { userId: 'u1' }, specialty: { nameAr: 'تصميم' } };
  const tx = {
    providerSpecialty: {
      updateMany: async (a: any) => { updates.push(a); return { count: o.count ?? 1 }; },
      findUnique: async () => (o.profileId === null ? null : { providerProfileId: o.profileId ?? 'pp1' }),
      count: async (a: any) => { counts.push(a); return o.approvedCount ?? 1; },
    },
    user: { update: async (a: any) => { userUpdates.push(a); return {}; } },
    accountAuditLog: { create: async (a: any) => { logs.push(a); return {}; } },
  };
  const prisma = { providerSpecialty: { findUnique: async () => row }, $transaction: async (fn: any) => fn(tx) };
  t.mock.module('../config/db', { namedExports: { prisma } });
  const { specialtyAdminReviewService } = await import(`./specialty-admin-review.service.ts?f=${Date.now()}-${Math.random()}`);
  return { svc: specialtyAdminReviewService, updates, logs, userUpdates, counts };
}

test('approve: status APPROVED + isPassed/badgeGrantedAt only; no AI field is written; audit log recorded with reason', async (t) => {
  const { svc, updates, logs } = await load(t);
  const r = await svc.decide('admin1', 'ps1', { decision: 'APPROVED', reason: 'نماذج مراجعة يدوياً' });
  assert.equal(r.status, 'APPROVED');
  assert.deepEqual(Object.keys(updates[0].data).sort(), ['badgeGrantedAt', 'isPassed', 'status']);
  for (const k of ['aiScore', 'latestScore', 'quizScore', 'ownershipCredibility', 'feasibilityScore', 'clarityScore']) assert.equal(k in updates[0].data, false, k);
  assert.equal(updates[0].where.status, 'UNDER_AI_REVIEW');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.userId, 'u1');
  assert.equal(logs[0].data.source, 'ADMIN');
  assert.equal(logs[0].data.eventType, 'SPECIALTY_ADMIN_DECISION');
  assert.equal(logs[0].data.metaData.adminId, 'admin1');
  assert.equal(logs[0].data.metaData.reason, 'نماذج مراجعة يدوياً');
});

test('reject: only the status changes', async (t) => {
  const { svc, updates } = await load(t);
  await svc.decide('admin1', 'ps1', { decision: 'REJECTED', reason: 'نماذج غير كافية' });
  assert.deepEqual(updates[0].data, { status: 'REJECTED' });
});

test('not under review → 409', async (t) => {
  const { svc } = await load(t, { row: { id: 'ps1', status: 'APPROVED' } });
  await assert.rejects(svc.decide('a', 'ps1', { decision: 'APPROVED', reason: 'سبب القرار' }), { statusCode: 409 });
});

test('missing specialty → 404', async (t) => {
  const { svc } = await load(t, { row: null });
  await assert.rejects(svc.decide('a', 'x', { decision: 'APPROVED', reason: 'سبب القرار' }), { statusCode: 404 });
});

test('lost race (zero rows updated) → 409 and no audit log', async (t) => {
  const { svc, logs } = await load(t, { count: 0 });
  await assert.rejects(svc.decide('a', 'ps1', { decision: 'APPROVED', reason: 'سبب القرار' }), { statusCode: 409 });
  assert.equal(logs.length, 0);
});

test('a reason is mandatory and the decision must be APPROVED or REJECTED', () => {
  assert.equal(specialtyReviewDecisionSchema.safeParse({ decision: 'APPROVED' }).success, false);
  assert.equal(specialtyReviewDecisionSchema.safeParse({ decision: 'APPROVED', reason: '   ' }).success, false);
  assert.equal(specialtyReviewDecisionSchema.safeParse({ decision: 'PENDING', reason: 'سبب القرار' }).success, false);
  assert.equal(specialtyReviewDecisionSchema.safeParse({ decision: 'REJECTED', reason: 'سبب القرار' }).success, true);
});

test('route sits under the admin/super-admin gate', () => {
  const src = readFileSync(new URL('../routes/admin-accreditation.routes.ts', import.meta.url), 'utf8');
  assert.match(src, /router\.use\(authenticate, requireActiveUser, authorize\(AccountType\.ADMIN, AccountType\.SUPER_ADMIN\)\)/);
  assert.match(src, /router\.post\('\/specialties\/:providerSpecialtyId\/decision'/);
});

for (const [n, tier] of [[1, 'PRO'], [2, 'PRO'], [3, 'EXPERT'], [4, 'EXPERT'], [5, 'TOP_RATED']] as const) {
  test(`approve: with ${n} APPROVED specialties the provider tier becomes ${tier}`, async (t) => {
    const { svc, userUpdates, counts } = await load(t, { approvedCount: n });
    await svc.decide('admin1', 'ps1', { decision: 'APPROVED', reason: 'سبب القرار' });
    assert.deepEqual(counts[0].where, { providerProfileId: 'pp1', status: 'APPROVED' });
    assert.deepEqual(userUpdates, [{ where: { id: 'u1' }, data: { tierLevel: tier } }]);
  });
}

test('reject: the tier is never touched', async (t) => {
  const { svc, userUpdates, counts } = await load(t, { approvedCount: 5 });
  await svc.decide('admin1', 'ps1', { decision: 'REJECTED', reason: 'سبب القرار' });
  assert.equal(userUpdates.length, 0);
  assert.equal(counts.length, 0);
});

test('lost race: no tier update', async (t) => {
  const { svc, userUpdates } = await load(t, { count: 0 });
  await assert.rejects(svc.decide('a', 'ps1', { decision: 'APPROVED', reason: 'سبب القرار' }), { statusCode: 409 });
  assert.equal(userUpdates.length, 0);
});
