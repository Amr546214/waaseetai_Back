import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// A client's first/last name (the "البيانات الأساسية" tab) is a governed change: it becomes a CLIENT_BASIC_INFO modification request,
// the stored name changes only when an admin approves it, a rejection leaves it, and the request shows in the client's own list and the
// admin queue. In-memory database (mock.module intercepts '../config/db').

function createDb(t: TestContext, o: { clientProfile?: any } = {}) {
  const state: any = {
    user: { id: 'client-1', status: 'ACTIVE', email: 'c@example.com', firstName: 'Nora', lastName: 'Q', accountType: 'CLIENT_INDIVIDUAL' },
    clientProfile: o.clientProfile === undefined ? { id: 'cp-1', userId: 'client-1', firstName: 'Nora', lastName: 'Quest', city: 'الرياض', completionPercentage: 10 } : o.clientProfile,
    requests: [] as any[]
  };
  let seq = 0;
  const providerUpsert = t.mock.fn(async (a: any) => ({ id: 'pp-1', userId: 'client-1', ...a.update }));
  const userUpdate = t.mock.fn(async (a: any) => { Object.assign(state.user, a.data); return state.user; });
  const matchesStatus = (rec: any, cond: any) => cond === undefined || (typeof cond === 'string' ? rec.status === cond : cond.in ? cond.in.includes(rec.status) : true);
  const matchesCategory = (rec: any, cond: any) => cond === undefined || (typeof cond === 'string' ? rec.category === cond : cond.startsWith ? String(rec.category).startsWith(cond.startsWith) : true);
  const matches = (rec: any, w: any) => (w.id === undefined || rec.id === w.id) && (w.providerId === undefined || rec.providerId === w.providerId) && matchesStatus(rec, w.status) && matchesCategory(rec, w.category);
  const db: any = {
    user: { findUnique: async () => ({ ...state.user, clientProfile: state.clientProfile }), updateMany: userUpdate, update: userUpdate },
    clientProfile: {
      findUnique: async () => state.clientProfile,
      upsert: async (a: any) => { state.clientProfile = { ...(state.clientProfile || {}), ...(state.clientProfile ? a.update : a.create) }; return state.clientProfile; },
      update: async (a: any) => { state.clientProfile = { ...state.clientProfile, ...a.data }; return state.clientProfile; }
    },
    providerProfile: { upsert: providerUpsert, update: async () => ({}), findUnique: async () => null },
    clientOnboarding: { findUnique: async () => null },
    profileModificationRequest: {
      findFirst: async (a: any) => state.requests.find((r: any) => matches(r, a.where)) || null,
      findUnique: async (a: any) => state.requests.find((r: any) => r.id === a.where.id) || null,
      findUniqueOrThrow: async (a: any) => { const r = state.requests.find((x: any) => x.id === a.where.id); if (!r) throw new Error('nf'); return r; },
      findMany: async (a: any) => [...state.requests].reverse().filter((r: any) => matches(r, { ...a.where, status: a.where.status })).map((r: any) => ({ ...r, provider: { firstName: 'Nora', lastName: 'Q', email: 'c@example.com', accountType: 'CLIENT_INDIVIDUAL' } })),
      create: async (a: any) => { const r = { id: `req-${++seq}`, createdAt: new Date(), ...a.data }; state.requests.push(r); return r; },
      updateMany: async (a: any) => { const hits = state.requests.filter((r: any) => matches(r, a.where)); hits.forEach((r: any) => Object.assign(r, a.data)); return { count: hits.length }; }
    },
    $transaction: async (fn: any) => fn(db)
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  return { state, db, userUpdate, providerUpsert };
}

async function load(t: TestContext, o: { clientProfile?: any } = {}) {
  const env = createDb(t, o);
  const bust = `?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(`./profile.service.ts${bust}`);
  const { providerProfileService } = await import(`./provider-profile.service.ts${bust}`);
  return { ...env, profileService, providerProfileService };
}

test('changing the name creates a PENDING_HUMAN_REVIEW CLIENT_BASIC_INFO request and does NOT change the stored name', async (t) => {
  const { profileService, state, userUpdate } = await load(t);
  const res = await profileService.updateTab('client-1', 'basics', { firstName: 'سارة', lastName: 'العتيبي' }, 'CLIENT');
  assert.equal(res.isPendingRequest, true);
  assert.equal(res.message, 'تم إرسال طلب تعديل البيانات الأساسية للمراجعة');
  assert.equal(state.clientProfile.firstName, 'Nora');
  assert.equal(state.clientProfile.lastName, 'Quest');
  assert.equal(userUpdate.mock.callCount(), 0);
  assert.equal(state.requests.length, 1);
  const r = state.requests[0];
  assert.equal(r.category, 'CLIENT_BASIC_INFO');
  assert.equal(r.status, 'PENDING_HUMAN_REVIEW');
  assert.equal(r.currentValue, 'Nora Quest');
  assert.equal(r.requestedValue, 'سارة العتيبي');
  assert.deepEqual(r.metadata.changes, { firstName: 'سارة', lastName: 'العتيبي' });
});

test('a second name request while one is pending is refused with 409 and creates nothing', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateTab('client-1', 'basics', { firstName: 'سارة', lastName: 'العتيبي' }, 'CLIENT');
  await assert.rejects(() => profileService.updateTab('client-1', 'basics', { firstName: 'منى', lastName: 'الحربي' }, 'CLIENT'), (e: any) => e.statusCode === 409 && /قيد المراجعة/.test(e.message));
  assert.equal(state.requests.length, 1);
});

test('approval applies the new name to ClientProfile (and recomputes completion); status APPROVED with appliedAt', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.updateTab('client-1', 'basics', { firstName: 'سارة', lastName: 'العتيبي' }, 'CLIENT');
  const updated = await providerProfileService.reviewSensitiveChange(state.requests[0].id, true);
  assert.equal(updated.status, 'APPROVED');
  assert.ok(updated.appliedAt);
  assert.equal(state.clientProfile.firstName, 'سارة');
  assert.equal(state.clientProfile.lastName, 'العتيبي');
  assert.equal(typeof state.clientProfile.completionPercentage, 'number');
});

test('rejection keeps the name, stores the reason, and a new request can be made afterwards', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.updateTab('client-1', 'basics', { firstName: 'سارة', lastName: 'العتيبي' }, 'CLIENT');
  const updated = await providerProfileService.reviewSensitiveChange(state.requests[0].id, false, 'الاسم لا يطابق الهوية');
  assert.equal(updated.status, 'REJECTED');
  assert.equal(updated.rejectionReason, 'الاسم لا يطابق الهوية');
  assert.equal(state.clientProfile.firstName, 'Nora');
  assert.equal(state.clientProfile.lastName, 'Quest');
  const again = await profileService.updateTab('client-1', 'basics', { firstName: 'منى', lastName: 'الحربي' }, 'CLIENT');
  assert.equal(again.isPendingRequest, true);
});

test('the request shows in the client\'s own list (no metadata) and in the admin queue', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.updateTab('client-1', 'basics', { firstName: 'سارة', lastName: 'العتيبي' }, 'CLIENT');
  const mine = await profileService.getMyChangeRequests('client-1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].category, 'CLIENT_BASIC_INFO');
  assert.equal(mine[0].requestedValue, 'سارة العتيبي');
  assert.equal('metadata' in mine[0], false);
  const queue = await providerProfileService.getPendingSensitiveReviews();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].fieldName, 'FULL_NAME');
  assert.equal(queue[0].provider.email, 'c@example.com');
  assert.equal(state.requests.length, 1);
});

test('other basics fields are unaffected: with the same name only the allowed contact fields save and no request is created', async (t) => {
  const { profileService, state, userUpdate } = await load(t);
  const res = await profileService.updateTab('client-1', 'basics', { firstName: 'Nora', lastName: 'Quest', city: 'جدة' }, 'CLIENT');
  assert.equal(res.isPendingRequest, undefined);
  assert.equal(state.requests.length, 0);
  assert.equal(userUpdate.mock.callCount(), 1);
  assert.equal(state.user.city, 'جدة');
});

test('a name of fewer than 2 characters is refused and nothing is created', async (t) => {
  const { profileService, state } = await load(t);
  await assert.rejects(() => profileService.updateTab('client-1', 'basics', { firstName: 'س', lastName: 'العتيبي' }, 'CLIENT'), (e: any) => e.statusCode === 400);
  assert.equal(state.requests.length, 0);
});

test('PROVIDER keeps its direct name save: no modification request, the provider profile is written (this change is client-only)', async (t) => {
  const { profileService, state, providerUpsert } = await load(t);
  await profileService.updateTab('client-1', 'basics', { firstName: 'Nora', lastName: 'Provider' }, 'PROVIDER').catch(() => undefined);
  assert.equal(state.requests.length, 0);
  assert.equal(providerUpsert.mock.callCount(), 1);
  assert.deepEqual(providerUpsert.mock.calls[0].arguments[0].update, { firstName: 'Nora', lastName: 'Provider' });
});

// The profile read tells the page the same story at every step (NOT_SUBMITTED -> PENDING_REVIEW -> REJECTED -> PENDING_REVIEW -> APPROVED).
test('GET profile reviewStatus.basicInfo follows the lifecycle: none, waiting, rejected with the reason, waiting again, approved', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  state.user.activeRole = 'CLIENT';
  const read = async () => (await profileService.getProfile('client-1')).currentProfileData.reviewStatus.basicInfo;
  assert.equal((await read()).status, 'NOT_SUBMITTED');
  await profileService.updateTab('client-1', 'basics', { firstName: 'سارة', lastName: 'العتيبي' }, 'CLIENT');
  const first = state.requests[0].id;
  const waiting = await read();
  assert.deepEqual([waiting.status, waiting.requestId, waiting.category, waiting.rejectionReason], ['PENDING_REVIEW', first, 'CLIENT_BASIC_INFO', null]);
  await providerProfileService.reviewSensitiveChange(first, false, 'الاسم لا يطابق الهوية');
  const rejected = await read();
  assert.deepEqual([rejected.status, rejected.rejectionReason], ['REJECTED', 'الاسم لا يطابق الهوية']);
  await profileService.updateTab('client-1', 'basics', { firstName: 'منى', lastName: 'الحربي' }, 'CLIENT');
  const second = state.requests[1].id;
  assert.deepEqual([(await read()).status, (await read()).requestId], ['PENDING_REVIEW', second]);
  await providerProfileService.reviewSensitiveChange(second, true);
  const approved = await read();
  assert.deepEqual([approved.status, approved.rejectionReason], ['APPROVED', null]);
});
