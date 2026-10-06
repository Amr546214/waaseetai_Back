import { test, mock, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// AUD-FND-000031/30/34: OTP purpose binding, attempt lock and session revocation, exercised against the REAL authRepository over an
// in-memory otp_verifications table (Prisma-style where matching incl. JSON `context.path` filters). No network, no real DB.

type Row = { id: string; userId: string; code: string; type: 'EMAIL' | 'PHONE'; expiresAt: Date; context: any; attempts: number; createdAt: Date };

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (k === 'AND') return (v as any[]).every((w) => matches(row, w));
    if (k === 'OR') return (v as any[]).some((w) => matches(row, w));
    if (k === 'context' && v && typeof v === 'object' && 'path' in (v as any)) {
      const val = (row.context ?? {})[(v as any).path[0]];
      return val === (v as any).equals;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as any;
      if ('gt' in o) return row[k] > o.gt;
      if ('in' in o) return o.in.includes(row[k]);
      if ('not' in o) return row[k] !== o.not;
    }
    return row[k] === v;
  });
}

// One set of module mocks for the whole file (module-level `mock`, installed before the service is imported); each test resets the
// shared in-memory state through setup().
const S: { rows: Row[]; seq: number; userState: any; sessions: { registered: number; revokedAll: string[] }; sent: any[] } = {
  rows: [], seq: 0, userState: {}, sessions: { registered: 0, revokedAll: [] }, sent: [],
};

const prisma: any = {
  otpVerification: {
    create: async ({ data }: any) => { const r = { id: `otp-${++S.seq}`, attempts: 0, context: null, createdAt: new Date(Date.now() + S.seq), ...data }; S.rows.push(r); return r; },
    findFirst: async ({ where, orderBy }: any) => { const m = S.rows.filter((r) => matches(r, where)); if (orderBy?.createdAt === 'desc') m.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); return m[0] ? { ...m[0] } : null; },
    findMany: async ({ where, orderBy, take }: any = {}) => { let m = S.rows.filter((r) => matches(r, where)); if (orderBy?.createdAt === 'desc') m = m.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); return (take ? m.slice(0, take) : m).map((r) => ({ ...r })); },
    update: async ({ where, data }: any) => { const r = S.rows.find((x) => x.id === where.id)!; if (data.attempts?.increment) r.attempts += data.attempts.increment; return r; },
    deleteMany: async ({ where }: any) => { let n = 0; for (let i = S.rows.length - 1; i >= 0; i--) if (matches(S.rows[i], where)) { S.rows.splice(i, 1); n++; } return { count: n }; },
    delete: async ({ where }: any) => { const i = S.rows.findIndex((x) => x.id === where.id); if (i >= 0) S.rows.splice(i, 1); return {}; },
    count: async ({ where }: any) => S.rows.filter((r) => matches(r, where)).length,
  },
  user: {
    findUnique: async ({ where }: any) => (where.id === S.userState.id || where.email === S.userState.email ? S.userState : null),
    findFirst: async () => S.userState,
    update: async ({ data }: any) => { Object.assign(S.userState, data); return S.userState; },
  },
  $transaction: async (fn: any) => fn({ affiliateProfile: { findUnique: async () => null } }),
};
let loaded: Promise<{ authService: any; authRepository: any }> | null = null;
function load() {
  if (loaded) return loaded;
  mock.module('../config/db', { namedExports: { prisma } });
  mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  mock.module('./session.service', { namedExports: { sessionService: {
    register: async () => { S.sessions.registered++; return {}; },
    revokeAll: async (userId: string) => { S.sessions.revokedAll.push(userId); return { count: 1 }; },
  } } });
  mock.module('./notification.service', { namedExports: { notificationService: {
    sendEmailOtp: async (to: string, code: string) => { S.sent.push({ to, code }); },
    sendPasswordResetEmail: async (to: string, _n: string, code: string) => { S.sent.push({ to, code, reset: true }); },
    isSmsAvailable: () => false, sendSmsOtp: async () => undefined,
  } } });


  loaded = (async () => ({ authService: (await import('./auth.service.ts')).authService, authRepository: (await import('../repositories/auth.repository.ts')).authRepository }))();
  return loaded;
}

async function setup(_t: TestContext, opts: { status?: string } = {}) {
  const { authService, authRepository } = await load();
  S.rows.length = 0;
  S.sessions.registered = 0; S.sessions.revokedAll = []; S.sent = [];
  for (const k of Object.keys(S.userState)) delete S.userState[k];
  Object.assign(S.userState, { id: 'user-1', email: 'victim@example.com', firstName: 'Victim', status: opts.status ?? 'PENDING_VERIFICATION', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT'], password: 'old-hash' });
  return { authService, authRepository, rows: S.rows, userState: S.userState, sessions: S.sessions, sent: S.sent };
}

const WRONG_PURPOSE_CODES = ['PASSWORD_RESET', 'SENSITIVE_CHANGE', 'checkout_payment', 'CLIENT_CONTRACT_SIGNATURE', 'PHONE_VERIFY'];

// ── #31 proof + fix: an OTP created for another purpose must never activate an account / mint a session ──
test('#31 a PASSWORD-RESET code is NOT accepted by verifyOtp (no activation, no session)', async (t) => {
  const { authService, authRepository, userState, sessions } = await setup(t);
  await authRepository.createPasswordResetOtp('user-1', '123456', new Date(Date.now() + 600_000));
  await assert.rejects(authService.verifyOtp({ userId: 'user-1', code: '123456' }), (e: any) => e.statusCode === 400);
  assert.equal(userState.status, 'PENDING_VERIFICATION', 'account must stay unverified');
  assert.equal(sessions.registered, 0, 'no session may be issued');
});

for (const purpose of WRONG_PURPOSE_CODES) {
  test(`#31 an OTP whose purpose is ${purpose} is rejected by activation (verifyOtp)`, async (t) => {
    const { authService, rows, userState, sessions } = await setup(t);
    rows.push({ id: 'x', userId: 'user-1', code: '654321', type: purpose === 'PHONE_VERIFY' ? 'PHONE' : 'EMAIL', expiresAt: new Date(Date.now() + 600_000), context: { purpose }, attempts: 0, createdAt: new Date() });
    await assert.rejects(authService.verifyOtp({ userId: 'user-1', code: '654321' }), (e: any) => e.statusCode === 400);
    assert.equal(userState.status, 'PENDING_VERIFICATION');
    assert.equal(sessions.registered, 0);
  });
}

test('#31 a legacy activation OTP with NO context is rejected (the user re-requests a code)', async (t) => {
  const { authService, rows, userState } = await setup(t);
  rows.push({ id: 'old', userId: 'user-1', code: '111222', type: 'EMAIL', expiresAt: new Date(Date.now() + 600_000), context: null, attempts: 0, createdAt: new Date() });
  await assert.rejects(authService.verifyOtp({ userId: 'user-1', code: '111222' }), (e: any) => e.statusCode === 400);
  assert.equal(userState.status, 'PENDING_VERIFICATION');
});

test('#31 a properly issued ACTIVATION code still activates and issues a session', async (t) => {
  const { authService, authRepository, userState, sessions } = await setup(t);
  await authRepository.createOtp('user-1', '246810', 'EMAIL', new Date(Date.now() + 600_000), 'ACTIVATION');
  const res = await authService.verifyOtp({ userId: 'user-1', code: '246810' });
  assert.ok(res.token);
  assert.equal(userState.status, 'ACTIVE');
  assert.equal(sessions.registered, 1);
});

test('#31 resend creates an ACTIVATION-purpose code; register does too', async (t) => {
  const { authService, rows } = await setup(t);
  await authService.resendOtp('user-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context?.purpose, 'ACTIVATION');
});

test('#31 a code issued for activation is NOT accepted by the password-reset flow either', async (t) => {
  const { authService, authRepository } = await setup(t);
  await authRepository.createOtp('user-1', '135790', 'EMAIL', new Date(Date.now() + 600_000), 'ACTIVATION');
  await assert.rejects(authService.verifyResetCode({ email: 'victim@example.com', code: '135790' }), (e: any) => e.statusCode === 400);
});

// ── #30 attempts lock ──
test('#30 five wrong activation codes delete the code and answer with the fixed Arabic message; the right code afterwards fails', async (t) => {
  const { authService, authRepository, rows, userState } = await setup(t);
  await authRepository.createOtp('user-1', '246810', 'EMAIL', new Date(Date.now() + 600_000), 'ACTIVATION');
  for (let i = 1; i <= 4; i++) {
    await assert.rejects(authService.verifyOtp({ userId: 'user-1', code: '000000' }), (e: any) => e.statusCode === 400 && /غير صحيح/.test(e.message));
    assert.equal(rows[0].attempts, i);
  }
  await assert.rejects(authService.verifyOtp({ userId: 'user-1', code: '000000' }), (e: any) => e.statusCode === 429 && e.message === 'تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد');
  assert.equal(rows.filter((r) => r.context?.purpose === 'ACTIVATION').length, 0, 'the code is deleted');
  await assert.rejects(authService.verifyOtp({ userId: 'user-1', code: '246810' }), (e: any) => e.statusCode === 400);
  assert.equal(userState.status, 'PENDING_VERIFICATION');
});

test('#30 the answer never reveals whether the account exists: unknown user and wrong code share one message', async (t) => {
  const { authService, authRepository } = await setup(t);
  await authRepository.createOtp('user-1', '246810', 'EMAIL', new Date(Date.now() + 600_000), 'ACTIVATION');
  const a = await authService.verifyOtp({ userId: 'user-1', code: '000000' }).catch((e: any) => e.message);
  const b = await authService.verifyOtp({ userId: '00000000-0000-4000-8000-000000000000', code: '000000' }).catch((e: any) => e.message);
  assert.equal(a, b);
});

test('#30 a locked activation code is not re-sent as is: resend creates a new one', async (t) => {
  const { authService, authRepository, rows, sent } = await setup(t);
  await authRepository.createOtp('user-1', '246810', 'EMAIL', new Date(Date.now() + 600_000), 'ACTIVATION');
  rows[0].attempts = 5;
  await authService.resendOtp('user-1');
  assert.notEqual(sent[0].code, '246810');
});

test('#30 the reset flow locks on the fifth wrong guess too (the code is deleted at once)', async (t) => {
  const { authService, authRepository, rows } = await setup(t);
  await authRepository.createPasswordResetOtp('user-1', '112233', new Date(Date.now() + 600_000));
  for (let i = 1; i <= 4; i++) await assert.rejects(authService.verifyResetCode({ email: 'victim@example.com', code: '000000' }), (e: any) => e.statusCode === 400);
  await assert.rejects(authService.verifyResetCode({ email: 'victim@example.com', code: '000000' }), (e: any) => e.statusCode === 429 && e.message === 'تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد');
  assert.equal(rows.length, 0, 'the fifth wrong guess deletes the reset code');
  await assert.rejects(authService.verifyResetCode({ email: 'victim@example.com', code: '112233' }), (e: any) => e.statusCode === 400);
});

// ── #34 sessions ──
test('#34 resetting the password revokes every session of the account', async (t) => {
  const { authService, authRepository, sessions, userState } = await setup(t, { status: 'ACTIVE' });
  await authRepository.createPasswordResetOtp('user-1', '112233', new Date(Date.now() + 600_000));
  await authService.resetPassword({ email: 'victim@example.com', code: '112233', newPassword: 'NewPassw0rd' });
  assert.deepEqual(sessions.revokedAll, ['user-1']);
  assert.notEqual(userState.password, 'old-hash');
});

test('#34 a wrong reset code revokes nothing', async (t) => {
  const { authService, authRepository, sessions } = await setup(t, { status: 'ACTIVE' });
  await authRepository.createPasswordResetOtp('user-1', '112233', new Date(Date.now() + 600_000));
  await assert.rejects(authService.resetPassword({ email: 'victim@example.com', code: '999999', newPassword: 'NewPassw0rd' }));
  assert.deepEqual(sessions.revokedAll, []);
});
