import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';

// A client's password change is a request an admin approves. Nothing is applied at request time, the plaintext is never stored / returned /
// logged, only a bcrypt hash waits (never listed), rejection keeps the old password, approval makes the new one work and the old one stop.

const OLD = 'OldPass123';
const NEW = 'NewPass456';

async function createDb(t: TestContext, o: { activeRole?: string; password?: string | null } = {}) {
  const state: any = {
    user: { id: 'client-1', status: 'ACTIVE', email: 'c@example.com', accountType: 'CLIENT_INDIVIDUAL', activeRole: o.activeRole ?? 'CLIENT', roles: ['CLIENT'], password: o.password === undefined ? await bcrypt.hash(OLD, 4) : o.password },
    requests: [] as any[]
  };
  let seq = 0;
  const logs: any[] = [];
  const revoked: any[] = [];
  const sameStatus = (rec: any, cond: any) => cond === undefined || (typeof cond === 'string' ? rec.status === cond : cond.in ? cond.in.includes(rec.status) : true);
  const sameCategory = (rec: any, cond: any) => cond === undefined || (typeof cond === 'string' ? rec.category === cond : cond.startsWith ? String(rec.category).startsWith(cond.startsWith) : true);
  const matches = (rec: any, w: any) => (w.id === undefined || rec.id === w.id) && (w.providerId === undefined || rec.providerId === w.providerId) && sameStatus(rec, w.status) && sameCategory(rec, w.category);
  const db: any = {
    user: {
      findUnique: async (a: any) => ({ ...state.user }),
      update: async (a: any) => { Object.assign(state.user, a.data); return state.user; },
    },
    profileModificationRequest: {
      findFirst: async (a: any) => state.requests.find((r: any) => matches(r, a.where)) || null,
      findUnique: async (a: any) => state.requests.find((r: any) => r.id === a.where.id) || null,
      findUniqueOrThrow: async (a: any) => state.requests.find((r: any) => r.id === a.where.id),
      findMany: async (a: any) => state.requests.filter((r: any) => matches(r, a.where)).map((r: any) => ({ ...r, provider: { firstName: 'N', lastName: 'Q', email: 'c@example.com', accountType: 'CLIENT_INDIVIDUAL' } })),
      create: async (a: any) => { const r = { id: `req-${++seq}`, createdAt: new Date(), ...a.data }; state.requests.push(r); return a.select ? Object.fromEntries(Object.keys(a.select).map(k => [k, (r as any)[k]])) : r; },
      update: async (a: any) => { const r = state.requests.find((x: any) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      updateMany: async (a: any) => { const hits = state.requests.filter((r: any) => matches(r, a.where)); hits.forEach((r: any) => Object.assign(r, a.data)); return { count: hits.length }; },
    },
    $transaction: async (fn: any) => fn(db),
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { logs.push(e); return {}; } } } });
  t.mock.module('./session.service', { namedExports: { sessionService: { revokeAll: async (...args: any[]) => { revoked.push(args); } } } });
  return { state, logs, revoked };
}

async function load(t: TestContext, o: { activeRole?: string; password?: string | null } = {}) {
  const env = await createDb(t, o);
  const bust = `?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(`./profile.service.ts${bust}`);
  const { providerProfileService } = await import(`./provider-profile.service.ts${bust}`);
  return { ...env, profileService, providerProfileService };
}
const input = (over: any = {}) => ({ currentPassword: OLD, newPassword: NEW, confirmPassword: NEW, ...over });

test('a wrong current password is refused (400) and no request is created', async (t) => {
  const { profileService, state } = await load(t);
  await assert.rejects(profileService.requestClientPasswordChange('client-1', input({ currentPassword: 'WrongPass1' })), (e: any) => e.statusCode === 400 && /الحالية غير صحيحة/.test(e.message));
  assert.equal(state.requests.length, 0);
});

test('a valid request creates a PENDING_HUMAN_REVIEW request, keeps the password, stores only a hash, and returns no password / hash', async (t) => {
  const { profileService, state, logs } = await load(t);
  const before = state.user.password;
  const created = await profileService.requestClientPasswordChange('client-1', input());
  assert.equal(state.user.password, before);                       // nothing applied
  assert.equal(await bcrypt.compare(OLD, state.user.password), true);
  assert.equal(state.requests.length, 1);
  const r = state.requests[0];
  assert.equal(r.category, 'CLIENT_PASSWORD_CHANGE');
  assert.equal(r.status, 'PENDING_HUMAN_REVIEW');
  assert.equal(r.currentValue, 'محجوب');
  assert.equal(r.requestedValue, 'كلمة مرور جديدة محجوبة');
  assert.equal(await bcrypt.compare(NEW, r.metadata.pendingPasswordHash), true);   // a real bcrypt hash, not the plaintext
  for (const blob of [JSON.stringify(created), JSON.stringify(r.currentValue), JSON.stringify(r.requestedValue), JSON.stringify(logs)]) {
    assert.doesNotMatch(blob, new RegExp(`${NEW}|${OLD}|pendingPasswordHash|\\$2[aby]\\$`));
  }
  assert.doesNotMatch(JSON.stringify({ ...r, metadata: undefined }), new RegExp(NEW));
});

test('a second request while one is pending is a 409 and creates nothing', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.requestClientPasswordChange('client-1', input());
  await assert.rejects(profileService.requestClientPasswordChange('client-1', input({ newPassword: 'Another789', confirmPassword: 'Another789' })), (e: any) => e.statusCode === 409);
  assert.equal(state.requests.length, 1);
});

test('the same password as the current one is refused', async (t) => {
  const { profileService, state } = await load(t);
  await assert.rejects(profileService.requestClientPasswordChange('client-1', input({ newPassword: OLD, confirmPassword: OLD })), (e: any) => e.statusCode === 400);
  assert.equal(state.requests.length, 0);
});

test('only a client can use it (activeRole CLIENT)', async (t) => {
  const { profileService, state } = await load(t, { activeRole: 'PROVIDER' });
  await assert.rejects(profileService.requestClientPasswordChange('client-1', input()), (e: any) => e.statusCode === 403);
  assert.equal(state.requests.length, 0);
});

test('a Google-only account (no password) gets a clear 400', async (t) => {
  const { profileService } = await load(t, { password: null });
  await assert.rejects(profileService.requestClientPasswordChange('client-1', input()), (e: any) => e.statusCode === 400 && /Google/.test(e.message));
});

test('the DTO enforces the registration / reset policy: weak, no uppercase, no digit, short, mismatch, same-as-current are all rejected', async () => {
  const { clientPasswordChangeSchema } = await import('../dtos/client-password-change.dto');
  const ok = clientPasswordChangeSchema.safeParse(input());
  assert.equal(ok.success, true);
  for (const bad of [{ newPassword: 'short1A', confirmPassword: 'short1A' }, { newPassword: 'alllowercase1', confirmPassword: 'alllowercase1' }, { newPassword: 'NoDigitsHere', confirmPassword: 'NoDigitsHere' }, { confirmPassword: 'Different123' }, { newPassword: OLD, confirmPassword: OLD }, { currentPassword: '' }, { newPassword: 'A1' + 'x'.repeat(80), confirmPassword: 'A1' + 'x'.repeat(80) }]) {
    assert.equal(clientPasswordChangeSchema.safeParse(input(bad)).success, false, JSON.stringify(bad));
  }
});

test('reject: the password does not change, the reason is kept, the hash is discarded, and a new request can be sent', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.requestClientPasswordChange('client-1', input());
  const id = state.requests[0].id;
  const out = await providerProfileService.reviewSensitiveChange(id, false, 'غير مطابق');
  assert.equal(out.status, 'REJECTED');
  assert.equal(out.rejectionReason, 'غير مطابق');
  assert.equal(await bcrypt.compare(OLD, state.user.password), true);
  assert.equal(await bcrypt.compare(NEW, state.user.password), false);
  assert.equal(state.requests[0].metadata.pendingPasswordHash, undefined);
  await profileService.requestClientPasswordChange('client-1', input());                 // allowed again
  assert.equal(state.requests.length, 2);
});

test('approve: the new password works, the old one does not, sessions are revoked, status APPROVED with appliedAt, no hash kept', async (t) => {
  const { profileService, providerProfileService, state, revoked } = await load(t);
  await profileService.requestClientPasswordChange('client-1', input());
  const out = await providerProfileService.reviewSensitiveChange(state.requests[0].id, true);
  assert.equal(out.status, 'APPROVED');
  assert.ok(out.appliedAt);
  assert.equal(await bcrypt.compare(NEW, state.user.password), true);
  assert.equal(await bcrypt.compare(OLD, state.user.password), false);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0][0], 'client-1');
  assert.equal(state.requests[0].metadata.pendingPasswordHash, undefined);
});

test('lists: the client list and the admin queue show the request without any password or hash', async (t) => {
  const { profileService, providerProfileService, state } = await load(t);
  await profileService.requestClientPasswordChange('client-1', input());
  const mine = await profileService.getMyChangeRequests('client-1');
  const queue = await providerProfileService.getPendingSensitiveReviews();
  for (const list of [mine, queue]) {
    const blob = JSON.stringify(list);
    assert.match(blob, /تغيير كلمة المرور/);
    assert.match(blob, /محجوب/);
    assert.doesNotMatch(blob, new RegExp(`${NEW}|${OLD}|pendingPasswordHash|\\$2[aby]\\$|"metadata"`));
  }
  assert.equal(mine[0].category, 'CLIENT_PASSWORD_CHANGE');
  assert.equal(state.requests.length, 1);
});

test('withdrawing the pending request discards its hash', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.requestClientPasswordChange('client-1', input());
  await profileService.cancelMyChangeRequest('client-1', state.requests[0].id);
  assert.equal(state.requests[0].status, 'CANCELLED');
  assert.equal(state.requests[0].metadata.pendingPasswordHash, undefined);
});

test('the direct change-password path cannot be used by a client to skip the review', async (t) => {
  const { providerProfileService, state } = await load(t);
  await assert.rejects(providerProfileService.changePassword('client-1', OLD, NEW), /طلب مراجعة/);
  assert.equal(await bcrypt.compare(OLD, state.user.password), true);
});
