import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Client governed profile edits, end to end on one in-memory database (mock.module intercepts '../config/db', so no connection is made):
//   free fields save at once -> the national id creates a modification request -> it shows in the client's own list and in the
//   admin queue -> approve applies it to ClientProfile / reject leaves it untouched -> errors are real errors, never a false success.

function createDb(t: TestContext) {
  const state: any = {
    user: { id: 'client-1', status: 'ACTIVE', email: 'c@example.com', firstName: 'Nora', lastName: 'Q', accountType: 'CLIENT_INDIVIDUAL' },
    clientProfile: { id: 'cp-1', userId: 'client-1', idNumber: '1000000001', country: 'السعودية', city: 'الرياض', completionPercentage: 10 } as any,
    requests: [] as any[]
  };
  let seq = 0;
  const userUpdateMany = t.mock.fn(async () => ({ count: 1 }));
  const matchesStatus = (rec: any, cond: any) => cond === undefined || (typeof cond === 'string' ? rec.status === cond : cond.in ? cond.in.includes(rec.status) : true);
  const matchesCategory = (rec: any, cond: any) => cond === undefined || (typeof cond === 'string' ? rec.category === cond : cond.startsWith ? String(rec.category).startsWith(cond.startsWith) : true);
  const matches = (rec: any, w: any) => (w.id === undefined || rec.id === w.id) && (w.providerId === undefined || rec.providerId === w.providerId)
    && matchesStatus(rec, w.status) && matchesCategory(rec, w.category);
  const db: any = {
    user: { findUnique: async () => ({ ...state.user, clientProfile: state.clientProfile }), updateMany: userUpdateMany, update: userUpdateMany },
    clientProfile: {
      findUnique: async () => state.clientProfile,
      upsert: async (a: any) => { state.clientProfile = { ...(state.clientProfile || {}), ...(state.clientProfile ? a.update : a.create) }; return state.clientProfile; },
      update: async (a: any) => { state.clientProfile = { ...state.clientProfile, ...a.data }; return state.clientProfile; }
    },
    profileModificationRequest: {
      findFirst: async (a: any) => state.requests.find((r: any) => matches(r, a.where)) || null,
      findUnique: async (a: any) => state.requests.find((r: any) => r.id === a.where.id) || null,
      findUniqueOrThrow: async (a: any) => { const r = state.requests.find((x: any) => x.id === a.where.id); if (!r) throw new Error('nf'); return r; },
      findMany: async (a: any) => state.requests.filter((r: any) => matches(r, { ...a.where, status: a.where.status })),
      create: async (a: any) => { const r = { id: `req-${++seq}`, createdAt: new Date(), ...a.data }; state.requests.push(r); return r; },
      updateMany: async (a: any) => {
        const hits = state.requests.filter((r: any) => matches(r, a.where));
        hits.forEach((r: any) => Object.assign(r, a.data));
        return { count: hits.length };
      }
    },
    $transaction: async (fn: any) => fn(db)
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  return { state, db, userUpdateMany };
}

async function load(t: TestContext) {
  const env = createDb(t);
  const bust = `?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(`./profile.service.ts${bust}`);
  const { providerProfileService } = await import(`./provider-profile.service.ts${bust}`);
  return { ...env, profileService, providerProfileService };
}

test('free fields (country / city) save immediately and create no request', async (t) => {
  const { profileService, state } = await load(t);
  const res = await profileService.updateTab('client-1', 'identity', { country: 'الإمارات', city: 'دبي' }, 'CLIENT');
  assert.equal(res.isPendingRequest, false);
  assert.equal(state.clientProfile.country, 'الإمارات');
  assert.equal(state.clientProfile.city, 'دبي');
  assert.equal(state.requests.length, 0);
});

test('the national id never changes directly: it creates a PENDING_HUMAN_REVIEW request with masked values, and the account is not locked', async (t) => {
  const { profileService, state, userUpdateMany } = await load(t);
  const res = await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  assert.equal(res.isPendingRequest, true);
  assert.equal(state.clientProfile.idNumber, '1000000001', 'stored id untouched until approval');
  assert.equal(state.requests.length, 1);
  const r = state.requests[0];
  assert.equal(r.category, 'CLIENT_IDENTITY');
  assert.equal(r.status, 'PENDING_HUMAN_REVIEW');
  assert.equal(r.requestedValue, '******6789');
  assert.equal(r.currentValue, '******0001');
  assert.equal(r.metadata.changes.idNumber, '2123456789');
  assert.equal(userUpdateMany.mock.callCount(), 0, 'no PENDING_VERIFICATION lockout');
});

test('place + id together: the place is saved, the id becomes a request', async (t) => {
  const { profileService, state } = await load(t);
  const res = await profileService.updateTab('client-1', 'identity', { city: 'جدة', idNumber: '2123456789' }, 'CLIENT');
  assert.equal(state.clientProfile.city, 'جدة');
  assert.equal(res.isPendingRequest, true);
  assert.equal(state.requests.length, 1);
});

test('a second id request while one is pending is refused (409) and nothing new is written', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  await assert.rejects(() => profileService.updateTab('client-1', 'identity', { idNumber: '2999999999' }, 'CLIENT'), (e: any) => e.statusCode === 409);
  assert.equal(state.requests.length, 1);
});

test('real errors, never a false success: bad id / unsupported fields / no changes / wrong role / bank tab', async (t) => {
  const { profileService, state, userUpdateMany } = await load(t);
  const bad = (p: Promise<any>, code = 400) => assert.rejects(() => p, (e: any) => e.statusCode === code);
  await bad(profileService.updateTab('client-1', 'identity', { idNumber: '123' }, 'CLIENT'));
  await bad(profileService.updateTab('client-1', 'identity', { nationality: 'سعودي' }, 'CLIENT'));
  await bad(profileService.updateTab('client-1', 'identity', { idExpiryDate: '2030-01-01' }, 'CLIENT'));
  await bad(profileService.updateTab('client-1', 'identity', { idNumber: '1000000001', city: 'الرياض' }, 'CLIENT'));
  await bad(profileService.updateTab('client-1', 'identity', { city: 'x' }, 'PROVIDER'));
  await bad(profileService.updateTab('client-1', 'banking', { iban: 'SA00' }, 'CLIENT'));
  assert.equal(state.requests.length, 0);
  assert.equal(userUpdateMany.mock.callCount(), 0);
  assert.equal(state.clientProfile.idNumber, '1000000001');
});

test('the client sees only their own CLIENT_* requests, without the raw metadata', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  state.requests.push({ id: 'other', providerId: 'someone-else', category: 'CLIENT_IDENTITY', status: 'PENDING_HUMAN_REVIEW', createdAt: new Date() });
  state.requests.push({ id: 'prov', providerId: 'client-1', category: 'CONTACT', status: 'APPROVED', createdAt: new Date() });
  const list = await profileService.getMyChangeRequests('client-1');
  assert.deepEqual(list.map((r: any) => r.id), ['req-1']);
  assert.equal('metadata' in list[0], false);
  assert.equal(JSON.stringify(list).includes('2123456789'), false);
});

test('cancel: pending -> CANCELLED; unknown -> 404; already decided / someone else\'s -> 404/409', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  const out = await profileService.cancelMyChangeRequest('client-1', 'req-1');
  assert.equal(out.status, 'CANCELLED');
  assert.equal(state.requests[0].status, 'CANCELLED');
  await assert.rejects(() => profileService.cancelMyChangeRequest('client-1', 'req-1'), (e: any) => e.statusCode === 409);
  await assert.rejects(() => profileService.cancelMyChangeRequest('client-1', 'nope'), (e: any) => e.statusCode === 404);
  await assert.rejects(() => profileService.cancelMyChangeRequest('intruder', 'req-1'), (e: any) => e.statusCode === 404);
});

test('admin queue shows the client request; APPROVE applies the id to ClientProfile and marks APPROVED', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  const queue = await providerProfileService.getPendingSensitiveReviews();
  assert.deepEqual(queue.map((r: any) => r.id), ['req-1']);

  const done = await providerProfileService.reviewSensitiveChange('req-1', true);
  assert.equal(done.status, 'APPROVED');
  assert.equal(state.clientProfile.idNumber, '2123456789');
  assert.ok(state.requests[0].appliedAt);
  assert.deepEqual((await providerProfileService.getPendingSensitiveReviews()).map((r: any) => r.id), []);
  assert.deepEqual((await providerProfileService.getPendingSensitiveReviews('APPROVED')).map((r: any) => r.id), ['req-1']);
  assert.equal((await profileService.getMyChangeRequests('client-1'))[0].status, 'APPROVED');
});

test('REJECT leaves the stored id unchanged, stores the reason, and shows REJECTED to the client', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  const done = await providerProfileService.reviewSensitiveChange('req-1', false, '  الصورة غير واضحة  ');
  assert.equal(done.status, 'REJECTED');
  assert.equal(done.rejectionReason, 'الصورة غير واضحة');
  assert.equal(state.clientProfile.idNumber, '1000000001');
  assert.equal(state.requests[0].appliedAt, null);
  assert.equal((await profileService.getMyChangeRequests('client-1'))[0].status, 'REJECTED');
  // the client can ask again once the previous request is decided
  const again = await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  assert.equal(again.isPendingRequest, true);
});

test('a decided request cannot be decided twice, and an unknown one is "not found"', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  await providerProfileService.reviewSensitiveChange('req-1', true);
  await assert.rejects(() => providerProfileService.reviewSensitiveChange('req-1', true), /REQUEST_NOT_PENDING_REVIEW/);
  await assert.rejects(() => providerProfileService.reviewSensitiveChange('req-1', false), /REQUEST_NOT_PENDING_REVIEW/);
  await assert.rejects(() => providerProfileService.reviewSensitiveChange('ghost', true), /REQUEST_NOT_FOUND/);
  assert.equal(state.clientProfile.idNumber, '2123456789');
});

test('if applying the change fails, the request goes back to pending (no false APPROVED)', async (t) => {
  const { profileService, providerProfileService, state, db } = await load(t);
  await profileService.updateTab('client-1', 'identity', { idNumber: '2123456789' }, 'CLIENT');
  const realUpsert = db.clientProfile.upsert;
  db.clientProfile.upsert = async () => { throw new Error('db down'); };
  await assert.rejects(() => providerProfileService.reviewSensitiveChange('req-1', true), /db down/);
  assert.equal(state.requests[0].status, 'PENDING_HUMAN_REVIEW');
  assert.equal(state.requests[0].appliedAt, null);
  assert.equal(state.clientProfile.idNumber, '1000000001');
  db.clientProfile.upsert = realUpsert;
  assert.equal((await providerProfileService.reviewSensitiveChange('req-1', true)).status, 'APPROVED');
});
