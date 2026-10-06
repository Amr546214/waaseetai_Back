import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// AUD-FND-000024 / 48 / 36: identity-verification fields (isNafathVerified, kycStatus, isVerified) and User.status are never written from a
// request body; nafath-verify is switched off; the provider setup wizard cannot change User.status.

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

type Writes = { providerUpsert: any[]; providerUpdate: any[]; providerUpdateMany: any[]; clientUpsert: any[]; clientUpdate: any[]; clientUpdateMany: any[]; userUpdate: any[] };
function mockDb(t: TestContext, o: { userStatus?: string; providerKyc?: string; clientKyc?: string } = {}) {
  const w: Writes = { providerUpsert: [], providerUpdate: [], providerUpdateMany: [], clientUpsert: [], clientUpdate: [], clientUpdateMany: [], userUpdate: [] };
  const prisma: any = {
    skill: { findMany: async () => [] },
    portfolioItem: { deleteMany: async () => ({}), createMany: async () => ({}) },
    providerProfile: {
      upsert: async (a: any) => { w.providerUpsert.push(a); return { id: 'pp1', ...a.create }; },
      findUnique: async () => ({ id: 'pp1', skills: [], portfolioItems: [], kycStatus: o.providerKyc ?? 'VERIFIED' }),
      update: async (a: any) => { w.providerUpdate.push(a); return { id: 'pp1', ...a.data }; },
      updateMany: async (a: any) => { w.providerUpdateMany.push(a); return { count: 1 }; },
    },
    clientProfile: {
      upsert: async (a: any) => { w.clientUpsert.push(a); return { id: 'cp1', ...a.create }; },
      update: async (a: any) => { w.clientUpdate.push(a); return { id: 'cp1', ...a.data }; },
      updateMany: async (a: any) => { w.clientUpdateMany.push(a); return { count: 1 }; },
      findUnique: async () => ({ id: 'cp1', kycStatus: o.clientKyc ?? 'VERIFIED' }),
    },
    user: {
      findUnique: async () => ({ id: 'u1', status: o.userStatus ?? 'SUSPENDED_REVIEW' }),
      update: async (a: any) => { w.userUpdate.push(a); return { id: 'u1', ...a.data }; },
    },
    $transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops({})),
  };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
  t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null } });
  t.mock.module('../utils/completion-calculators', { namedExports: {
    computeProviderCompletion: () => 80, computeClientCompletion: () => 80, computeClientMissingItems: () => [], computeProviderMissingItems: () => [],
  } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
  t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: {} } });
  t.mock.module('../services/client-profile.service', { namedExports: { clientProfileService: {} } });
  return w;
}

const providerBody = (identityExtra: any = {}) => ({
  details: { idNumber: '1234567890', occupation: 'مصمم', expYears: '3 الى 5 سنوات' }, identity: { frontId: 'a', backId: 'b', certs: [], ...identityExtra },
  bank: {}, documents: {}, agreements: { accurate: true, terms: true, privacy: true }, specialties: {}, portfolio: null,
});

// ── #24 ──
test('#24 nafath-verify is switched off: 503 with the honest Arabic message, NO write at all', async (t) => {
  const w = mockDb(t);
  const { ClientProfileController } = await import(`./client-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
  const res = mockRes();
  let nextErr: any;
  await new ClientProfileController().nafathVerify({ user: { userId: 'u1' }, body: { isNafathVerified: true } } as any, res, (e: any) => { nextErr = e; });
  const status = nextErr?.statusCode ?? res.statusCode;
  assert.ok(status === 503 || status === 501, `expected 501/503, got ${status}`);
  assert.equal(nextErr?.message ?? res.body?.message, 'التحقق عبر نفاذ غير متاح حاليًا');
  assert.notEqual(res.body?.success, true);
  assert.deepEqual([w.clientUpsert.length, w.clientUpdate.length, w.clientUpdateMany.length], [0, 0, 0]);
});

test('#24 the nafath-verify route still exists (the feature is disabled, not deleted)', () => {
  assert.match(readFileSync(new URL('../routes/client-profile.routes.ts', import.meta.url), 'utf8'), /router\.post\('\/nafath-verify'/);
});

// ── #48 ──
test('#48 provider setup: a body carrying identity.isNafathVerified:true / kycStatus / isVerified writes none of them', async (t) => {
  const w = mockDb(t);
  const { saveSetupData } = await import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
  const res = mockRes();
  const body: any = providerBody({ isNafathVerified: true, kycStatus: 'VERIFIED', isVerified: true });
  body.isVerified = true; body.kycStatus = 'VERIFIED'; body.isNafathVerified = true; body.details.isVerified = true;
  await saveSetupData({ user: { id: 'u1' }, body } as any, res);
  assert.equal(res.statusCode, 200);
  const up = w.providerUpsert[0];
  for (const side of [up.create, up.update]) {
    assert.equal('isNafathVerified' in side, false, 'isNafathVerified must not be written');
    assert.equal('isVerified' in side, false);
  }
  assert.equal('kycStatus' in up.update, false, 'an existing kycStatus (e.g. VERIFIED) is never overwritten by the wizard');
});

test('#48 provider setup: a first submission moves UNVERIFIED/REJECTED to PENDING but never touches VERIFIED', async (t) => {
  const w = mockDb(t);
  const { saveSetupData } = await import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
  await saveSetupData({ user: { id: 'u1' }, body: providerBody() } as any, mockRes());
  assert.deepEqual(w.providerUpdateMany[0].where.kycStatus, { in: ['UNVERIFIED', 'REJECTED'] });
  assert.equal(w.providerUpdateMany[0].data.kycStatus, 'PENDING');
});

test('#48 client setup: the body cannot set isNafathVerified/kycStatus/isVerified and an existing kycStatus is not overwritten', async (t) => {
  const w = mockDb(t);
  const { ClientProfileController } = await import(`./client-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
  const body: any = { details: { idNumber: '1234567890' }, identity: { frontId: 'a', backId: 'b', isNafathVerified: true, kycStatus: 'VERIFIED' }, documents: {}, agreements: {}, bank: {}, isNafathVerified: true, kycStatus: 'VERIFIED', isVerified: true };
  const res = mockRes();
  await new ClientProfileController().saveSetupData({ user: { userId: 'u1' }, body } as any, res, (e: any) => { throw e; });
  const up = w.clientUpsert[0];
  for (const side of [up.create, up.update]) {
    assert.equal('isNafathVerified' in side, false);
    assert.equal('isVerified' in side, false);
  }
  assert.equal('kycStatus' in up.update, false);
  assert.deepEqual(w.clientUpdateMany[0].where.kycStatus, { in: ['UNVERIFIED', 'REJECTED'] });
});

test('#48 no request-reachable code path writes isNafathVerified / kycStatus / isVerified except the admin KYC decision', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const f of ['../controllers/client-profile.controller.ts', '../controllers/provider-profile.controller.ts']) {
    const src = read(f).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /isNafathVerified\s*:\s*(true|identity)/, f);
    assert.doesNotMatch(src, /isVerified\s*:\s*true/, f);
  }
  // the only writers left: admin approval/rejection (onboarding.service) — guarded by the admin routes
  const onboarding = read('../services/onboarding.service.ts');
  assert.match(onboarding, /kycStatus: KYCStatus\.VERIFIED, isVerified: true/);
});

// ── #36 ──
for (const status of ['SUSPENDED_REVIEW', 'SUSPENDED', 'PENDING_VERIFICATION', 'ACTIVE']) {
  test(`#36 provider setup never writes User.status (user is ${status})`, async (t) => {
    const w = mockDb(t, { userStatus: status });
    const { saveSetupData } = await import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
    const res = mockRes();
    await saveSetupData({ user: { id: 'u1' }, body: providerBody() } as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(w.userUpdate.some((u) => 'status' in u.data), false, 'the wizard must not change User.status');
  });
}
