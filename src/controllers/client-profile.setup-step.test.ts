import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// PUT /api/client/profile/setup/step/:step — each wizard step is stored the moment the user moves on. One in-memory database behind mocked
// prisma / storage; the real controller, DTO schemas, identity guard and onboarding service run.

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

async function createDb(t: TestContext, initial: Record<string, unknown> = {}) {
  const state: any = {
    profile: { userId: 'u1', idNumber: null, dob: null, country: null, city: null, industry: null, address: null, frontIdUrl: null, backIdUrl: null, paypalPayoutEmail: null, paymentType: null,
      supportingDocsUrl: null, notes: null, accurateAgreed: false, termsAgreed: false, privacyAgreed: false, isProfileComplete: false, kycStatus: 'UNVERIFIED', completionPercentage: 0, firstName: 'Nora', lastName: 'Q', avatarUrl: 'https://x/a.png', bio: 'نبذة', ...initial } as any,
    onboarding: null as any,
  };
  const db: any = {
    clientProfile: {
      findUnique: async () => ({ ...state.profile }),
      upsert: async (a: any) => { state.profile = { ...state.profile, ...Object.fromEntries(Object.entries(a.update).filter(([, v]) => v !== undefined)) }; return { ...state.profile }; },
      update: async (a: any) => { state.profile = { ...state.profile, ...a.data }; return { ...state.profile }; },
      updateMany: async (a: any) => { if (a.where.kycStatus?.in?.includes(state.profile.kycStatus)) { state.profile = { ...state.profile, ...a.data }; return { count: 1 }; } return { count: 0 }; },
    },
    user: { findUnique: async () => ({ id: 'u1', firstName: 'Nora', lastName: 'Q', avatarUrl: 'https://x/a.png', accountType: 'CLIENT_INDIVIDUAL', idNumber: null }) },
    clientOnboarding: {
      findUnique: async () => state.onboarding,
      create: async (a: any) => { state.onboarding = { ...a.data }; return state.onboarding; },
      update: async (a: any) => { state.onboarding = { ...state.onboarding, ...a.data }; return state.onboarding; },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  t.mock.module('../utils/cloudinary-storage', { namedExports: { storeKycFileIfNeeded: async (v: any) => (v ? `private:${String(v).slice(0, 12)}` : undefined), storeDataUriIfNeeded: async (v: any) => v } });
  t.mock.module('../utils/kyc-value-guard', { namedExports: { assertKycFileValues: () => undefined, isAcceptableKycDocumentValue: () => true } });
  // a fresh onboarding service bound to THIS test's database (the module cache would otherwise keep the first test's mock)
  const { OnboardingService } = await import(`../services/onboarding.service.ts?fixture=${Date.now()}-${Math.random()}`);
  t.mock.module('../services/onboarding.service', { namedExports: { onboardingService: new OnboardingService(), OnboardingService } });
  return state;
}

async function load(t: TestContext, initial?: Record<string, unknown>) {
  const state = await createDb(t, initial);
  const { ClientProfileController } = await import(`./client-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const c = new ClientProfileController();
  const step = async (n: string | number, body: any) => { const r = res(); let err: any = null; await c.saveSetupStep({ user: { userId: 'u1' }, params: { step: String(n) }, body } as any, r, (e: any) => { err = e; }); return { r, err }; };
  const get = async () => { const r = res(); await c.getSetupData({ user: { userId: 'u1' } } as any, r, () => undefined); return r.body.data; };
  return { state, step, get };
}

const DETAILS = { idNumber: '2000000001', dob: '1990-01-01', country: 'السعودية', city: 'الرياض', occupation: 'مهندس', address: 'حي النخيل' };

test('step 1 stores the details at once, partial values keep what is stored, and the completion follows', async (t) => {
  const { state, step } = await load(t);
  const { r } = await step(1, { details: DETAILS });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([state.profile.idNumber, state.profile.country, state.profile.city, state.profile.industry, state.profile.address], ['2000000001', 'السعودية', 'الرياض', 'مهندس', 'حي النخيل']);
  assert.equal(new Date(state.profile.dob).toISOString().slice(0, 10), '1990-01-01');
  assert.ok(r.body.data.completionPercentage > 0);
  // a later partial save with empty values never erases
  await step(1, { details: { idNumber: '', country: '', city: 'جدة' } });
  assert.equal(state.profile.idNumber, '2000000001');
  assert.equal(state.profile.country, 'السعودية');
  assert.equal(state.profile.city, 'جدة');
});

test('step 1 rejects a bad id / a future birth date (400 with field errors) and writes nothing', async (t) => {
  const { state, step } = await load(t);
  const bad = await step(1, { details: { idNumber: '123' } });
  assert.equal(bad.r.statusCode, 400);
  assert.ok(bad.r.body.errors.some((e: any) => /idNumber/.test(e.path)));
  assert.equal((await step(1, { details: { dob: '2999-01-01' } })).r.statusCode, 400);
  assert.equal(state.profile.idNumber, null);
});

test('step 1 cannot change the identity of a VERIFIED account (409)', async (t) => {
  const { state, step } = await load(t, { kycStatus: 'VERIFIED', idNumber: '1000000009', dob: new Date('1980-01-01') });
  const { err } = await step(1, { details: { idNumber: '2000000001' } });
  assert.equal(err?.statusCode, 409);
  assert.equal(state.profile.idNumber, '1000000009');
});

test('step 2 stores the identity documents; the review record exists only when the id number AND both documents are there (PENDING, never re-opened)', async (t) => {
  const { state, step } = await load(t);
  await step(2, { identity: { frontId: 'data:image/png;base64,AAAA' } });
  assert.ok(state.profile.frontIdUrl);
  assert.equal(state.onboarding, null, 'no review with one document / no id number');
  await step(1, { details: DETAILS });
  await step(2, { identity: { backId: 'data:image/png;base64,BBBB' } });
  assert.ok(state.profile.backIdUrl);
  assert.equal(state.onboarding?.status, 'PENDING');
  assert.equal(state.profile.kycStatus, 'PENDING');
  // the same step again with no new file does not change the review
  const before = JSON.stringify(state.onboarding);
  await step(2, { identity: {} });
  assert.equal(JSON.stringify(state.onboarding), before);
});

test('step 3 stores the PayPal email (normalised); an invalid or empty one is a 400 and nothing is written', async (t) => {
  const { state, step } = await load(t);
  const ok = await step(3, { paypalPayoutEmail: '  Pay@Example.COM ' });
  assert.equal(ok.r.statusCode, 200);
  assert.equal(state.profile.paypalPayoutEmail, 'pay@example.com');
  assert.equal(state.profile.paymentType, 'paypal');
  for (const bad of ['not-an-email', '', '   ']) {
    const r = (await step(3, { paypalPayoutEmail: bad })).r;
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(state.profile.paypalPayoutEmail, 'pay@example.com');
});

test('step 4 stores the optional documents / notes', async (t) => {
  const { state, step } = await load(t);
  await step(4, { documents: { notes: 'ملاحظات', supportingDocs: 'data:application/pdf;base64,CCCC' } });
  assert.equal(state.profile.notes, 'ملاحظات');
  assert.ok(state.profile.supportingDocsUrl);
});

test('an unknown step is a 400; the agreements / isProfileComplete are never touched by a step save', async (t) => {
  const { state, step } = await load(t);
  for (const n of ['0', '5', 'x', '']) assert.equal((await step(n, {})).r.statusCode, 400, n);
  await step(1, { details: DETAILS }); await step(3, { paypalPayoutEmail: 'p@x.co' }); await step(4, { documents: { notes: 'n' } });
  assert.equal(state.profile.accurateAgreed, false);
  assert.equal(state.profile.termsAgreed, false);
  assert.equal(state.profile.isProfileComplete, false);
});

test('after steps 1, 2 and 3 a fresh GET /setup returns everything that was saved (this is what a refresh reads)', async (t) => {
  const { step, get } = await load(t);
  await step(1, { details: DETAILS });
  await step(2, { identity: { frontId: 'data:image/png;base64,AAAA', backId: 'data:image/png;base64,BBBB' } });
  await step(3, { paypalPayoutEmail: 'pay@example.com' });
  const saved = await get();
  assert.equal(saved.idNumber, '2000000001');
  assert.equal(saved.city, 'الرياض');
  assert.equal(saved.paypalPayoutEmail, 'pay@example.com');
  assert.equal(saved.kycStatus, 'PENDING');
  assert.ok(saved.frontIdUrl && saved.backIdUrl);
  assert.ok(saved.completionPercentage > 0);
});
