import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// AUD-FND-000031/30/34 on the remaining OTP paths: provider sensitive-change confirmation, wallet checkout confirmation, and the
// provider password change (other sessions are revoked).

const LOCKED = 'تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد';

// ── sensitive change ──
async function sensitive(t: TestContext, otpRow: any) {
  const state = { otp: otpRow ? { ...otpRow } : null, deleted: 0, attemptsIncremented: 0, audit: [] as any[] };
  const prisma: any = {
    profileModificationRequest: { findFirst: async () => ({ id: 'req-1', providerId: 'p1', status: 'PENDING_OTP', category: 'CONTACT', metadata: {} }) },
    otpVerification: {
      findFirst: async (args: any) => {
        const ands = (args.where.AND ?? []).map((c: any) => c.context.equals);
        const o = state.otp;
        if (!o || o.type !== args.where.type) return null;
        return o.context?.purpose === ands[0] && o.context?.requestId === ands[1] ? { ...o } : null; // purpose + requestId MUST match
      },
      update: async () => { state.attemptsIncremented++; if (state.otp) state.otp.attempts++; return {}; },
      delete: async () => { state.deleted++; state.otp = null; return {}; },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { state.audit.push(e); return {}; } } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
  t.mock.module('./session.service', { namedExports: { sessionService: { revokeAll: async () => ({}) } } });
  t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {} } } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?f=${Date.now()}-${Math.random()}`);
  return { svc: providerProfileService, state };
}
const row = (over: any = {}) => ({ id: 'o1', userId: 'p1', type: 'EMAIL', code: '123456', attempts: 0, expiresAt: new Date(Date.now() + 600_000), context: { purpose: 'SENSITIVE_CHANGE', requestId: 'req-1' }, ...over });

for (const [name, context] of [
  ['an ACTIVATION code', { purpose: 'ACTIVATION' }],
  ['a PASSWORD_RESET code', { purpose: 'PASSWORD_RESET' }],
  ['a checkout code', { purpose: 'checkout_payment', orderId: 'x' }],
  ['a SENSITIVE_CHANGE code of ANOTHER request', { purpose: 'SENSITIVE_CHANGE', requestId: 'other' }],
  ['a legacy code with no context', null],
] as Array<[string, any]>) {
  test(`#31 sensitive change: ${name} cannot confirm the request`, async (t) => {
    const { svc, state } = await sensitive(t, row({ context }));
    await assert.rejects(svc.verifySensitiveChange('p1', 'req-1', '123456'), /INVALID_OR_EXPIRED_OTP/);
    assert.equal(state.deleted, 0, 'the foreign code is left untouched (it is not consumed)');
  });
}

test('#30 sensitive change: wrong guesses are counted and the fifth deletes the code', async (t) => {
  const { svc, state } = await sensitive(t, row());
  for (let i = 1; i <= 4; i++) {
    await assert.rejects(svc.verifySensitiveChange('p1', 'req-1', '000000'), /INVALID_OR_EXPIRED_OTP/);
    assert.equal(state.otp.attempts, i);
  }
  await assert.rejects(svc.verifySensitiveChange('p1', 'req-1', '000000'), /OTP_ATTEMPTS_EXCEEDED/);
  assert.equal(state.otp, null, 'deleted');
  assert.equal(state.deleted, 1);
  await assert.rejects(svc.verifySensitiveChange('p1', 'req-1', '123456'), /INVALID_OR_EXPIRED_OTP/);
});

// ── wallet checkout ──
async function checkout(t: TestContext, ctx: any, attempts: number) {
  const spies = { updated: 0, deleted: 0 };
  const prisma: any = {
    order: { findFirst: async () => ({ id: 'order-1', status: 'PENDING_PAYMENT', total: 10, items: [], user: {} }) },
    otpVerification: {
      findMany: async () => [{ id: 'o1', code: '111111', attempts, expiresAt: new Date(Date.now() + 60_000), context: ctx }],
      update: async () => { spies.updated++; return {}; },
      delete: async () => { spies.deleted++; return {}; },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
  const { cartCheckoutService } = await import(`./cart-checkout.service.ts?f=${Date.now()}-${Math.random()}`);
  return { svc: cartCheckoutService, spies };
}
const payCtx = { purpose: 'checkout_payment', orderId: 'order-1', paymentReference: 'PAY-1', paymentMethod: 'wallet' };

test('#31 checkout: a code of another purpose for the same user is not a payment code (400, nothing consumed)', async (t) => {
  const { svc, spies } = await checkout(t, { purpose: 'PASSWORD_RESET' }, 0);
  await assert.rejects(svc.confirmPayment('u1', 'order-1', '111111'), (e: any) => e.statusCode === 400);
  assert.deepEqual(spies, { updated: 0, deleted: 0 });
});

test('#30 checkout: a wrong code is counted; the fifth wrong guess deletes the code with the fixed message (429)', async (t) => {
  const first = await checkout(t, payCtx, 0);
  await assert.rejects(first.svc.confirmPayment('u1', 'order-1', '000000'), (e: any) => e.statusCode === 400);
  assert.deepEqual(first.spies, { updated: 1, deleted: 0 });
});
test('#30 checkout: the fifth wrong guess deletes the code', async (t) => {
  const { svc, spies } = await checkout(t, payCtx, 4);
  await assert.rejects(svc.confirmPayment('u1', 'order-1', '000000'), (e: any) => e.statusCode === 429 && e.message === LOCKED);
  assert.deepEqual(spies, { updated: 0, deleted: 1 });
});
test('#30 checkout: a code that already reached five attempts is deleted even if the right code is sent', async (t) => {
  const { svc, spies } = await checkout(t, payCtx, 5);
  await assert.rejects(svc.confirmPayment('u1', 'order-1', '111111'), (e: any) => e.statusCode === 429);
  assert.equal(spies.deleted, 1);
});

// ── provider password change ──
test('#34 changing the password signs the OTHER sessions out and keeps the current one', async (t) => {
  const revoked: any[] = [];
  const prisma: any = { user: { findUnique: async () => ({ password: 'hash' }), update: async () => ({}) } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('bcrypt', { defaultExport: { compare: async (plain: string) => plain === 'Current#Pass1', hash: async () => 'new-hash' }, namedExports: { compare: async (plain: string) => plain === 'Current#Pass1', hash: async () => 'new-hash' } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./session.service', { namedExports: { sessionService: { revokeAll: async (...a: any[]) => { revoked.push(a); return {}; } } } });
  t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {} } } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?f=${Date.now()}-${Math.random()}`);
  (providerProfileService as any).logAppliedChange = async () => undefined;
  await providerProfileService.changePassword('p1', 'Current#Pass1', 'Another#Pass2', { sessionId: 'sess-current' });
  assert.deepEqual(revoked, [['p1', 'PASSWORD_CHANGED', 'sess-current']]);
});

test('#34 a rejected password change (wrong current password) revokes nothing', async (t) => {
  const revoked: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: { user: { findUnique: async () => ({ password: 'hash' }), update: async () => ({}) } } } });
  t.mock.module('bcrypt', { defaultExport: { compare: async () => false, hash: async () => 'x' }, namedExports: { compare: async () => false, hash: async () => 'x' } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./session.service', { namedExports: { sessionService: { revokeAll: async (...a: any[]) => { revoked.push(a); } } } });
  t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {} } } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?f=${Date.now()}-${Math.random()}`);
  await assert.rejects(providerProfileService.changePassword('p1', 'wrong', 'Another#Pass2', {}), /CURRENT_PASSWORD_INCORRECT/);
  assert.equal(revoked.length, 0);
});

test('#34 revokeAll only touches the account sessions that are still active and records an audit event', async (t) => {
  const calls: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: { userSession: { updateMany: async (a: any) => { calls.push(a); return { count: 2 }; } } } } });
  const audit: any[] = [];
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { audit.push(e); return {}; } } } });
  const { sessionService } = await import(`./session.service.ts?f=${Date.now()}-${Math.random()}`);
  await sessionService.revokeAll('u1', 'PASSWORD_RESET');
  assert.deepEqual(calls[0].where, { userId: 'u1', revokedAt: null });
  assert.ok(calls[0].data.revokedAt instanceof Date);
  await sessionService.revokeAll('u1', 'PASSWORD_CHANGED', 'keep-me');
  assert.deepEqual(calls[1].where, { userId: 'u1', revokedAt: null, id: { not: 'keep-me' } });
  assert.equal(audit[0].eventType, 'SESSIONS_REVOKED_ALL');
});

test('static: no OTP creation without a purpose anywhere in the services', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const auth = read('./auth.service.ts');
  assert.equal((auth.match(/createOtp\(/g) || []).length, (auth.match(/OtpPurpose\.ACTIVATION\)/g) || []).length);
  assert.doesNotMatch(read('../repositories/auth.repository.ts'), /findValidOtp/);
  assert.match(read('./provider-profile.service.ts'), /purpose: OtpPurpose\.SENSITIVE_CHANGE, requestId: request\.id/);
});
