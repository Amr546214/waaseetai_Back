import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.2A: client-profile.controller.ts#saveSetupData() must recalculate
// ClientProfile.completionPercentage from the FINAL post-write state after
// its upsert, using the shared CLIENT calculator, and must never write
// User.profileCompletionPercent. isProfileComplete (a separate pre-existing
// boolean) must remain exactly as it was.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function createSetupDataMockPrisma(t: TestContext) {
  let clientProfileState: any = {
    userId: 'user-1',
    firstName: null,
    lastName: null,
    avatarUrl: null,
    bio: null,
    companyName: null,
    idNumber: null,
    bankName: null,
    isProfileComplete: false,
    completionPercentage: 0
  };
  const userFixture = {
    id: 'user-1',
    firstName: 'Amr',
    lastName: 'Okasha',
    phoneNumber: '0500000000',
    avatarUrl: 'https://example.com/a.png',
    idNumber: null,
    ibanNumber: null,
    bankName: null,
    accountHolderName: null
  };

  const clientUpdateSpy = t.mock.fn((args: any) => {
    clientProfileState = { ...clientProfileState, ...args.data };
    return { ...clientProfileState };
  });

  const prismaMock = {
    clientProfile: {
      upsert: t.mock.fn((args: any) => {
        clientProfileState = { ...clientProfileState, ...args.update };
        return { ...clientProfileState };
      }),
      update: clientUpdateSpy,
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null
    },
    user: {
      findUnique: async () => ({ ...userFixture })
    },
    $transaction: async (ops: any) => Promise.all(ops)
  };

  return { prismaMock, clientUpdateSpy, getClientProfileState: () => clientProfileState };
}

async function loadControllerWithFixture(t: TestContext) {
  const mocks = createSetupDataMockPrisma(t);
  t.mock.module('../config/db', { namedExports: { prisma: mocks.prismaMock } });
  const moduleUrl = `./client-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const { clientProfileController } = await import(moduleUrl);
  return { clientProfileController, ...mocks };
}

test('client saveSetupData: recalculates ClientProfile.completionPercentage after the mutation, from the final state', async (t) => {
  const { clientProfileController, clientUpdateSpy } = await loadControllerWithFixture(t);

  const req: any = {
    user: { userId: 'user-1' },
    body: {
      details: { idNumber: '1234567890', dob: null, country: 'SA', city: 'Riyadh', occupation: 'Tech', address: '123 St' },
      identity: {},
      bank: { paymentType: 'paypal', paypalPayoutEmail: 'pay@example.com' },
      documents: {},
      agreements: { accurate: true, terms: true, privacy: true }
    }
  };
  const res = createMockRes();

  await clientProfileController.saveSetupData(req, res, () => {});

  assert.equal(res.statusCode, 200);
  const completionCall = clientUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');
  assert.equal(completionCall.arguments[0].data.completionPercentage > 0, true);
});

test('client saveSetupData: isProfileComplete reflects what was STORED (a sparse POST is not complete) and the completion write never touches User', async (t) => {
  const { clientProfileController, prismaMock } = await loadControllerWithFixture(t);
  const userUpdateSpy = (prismaMock.user as any).update;
  assert.equal(userUpdateSpy, undefined); // prismaMock.user has no update method at all — proves saveSetupData cannot call it

  const sparse: any = { user: { userId: 'user-1' }, body: { details: { idNumber: '1234567890' }, identity: {}, bank: {}, documents: {}, agreements: { accurate: true, terms: true, privacy: true } } };
  const res = createMockRes();
  await clientProfileController.saveSetupData(sparse, res, () => {});
  assert.equal(res.body.data.isProfileComplete, false, 'country/city/occupation/address/dob were not stored');

  const full: any = { user: { userId: 'user-1' }, body: { details: { idNumber: '1234567890', dob: '1990-05-01', country: 'السعودية', city: 'الرياض', occupation: 'مهندس', address: 'حي النخيل' }, identity: {}, bank: {}, documents: {}, agreements: { accurate: true, terms: true, privacy: true } } };
  const res2 = createMockRes();
  await clientProfileController.saveSetupData(full, res2, () => {});
  assert.equal(res2.body.data.isProfileComplete, true);
});

// ---- Client PayPal payout (setup) ----

function paypalSetupReq(bank: any) {
  return {
    user: { userId: 'user-1' },
    body: { details: { idNumber: '1234567890' }, identity: {}, bank, documents: {}, agreements: { accurate: true, terms: true, privacy: true } }
  } as any;
}

test('client saveSetupData: valid PayPal email succeeds without bank fields and never maps into iban/accountHolder', async (t) => {
  const { clientProfileController, getClientProfileState } = await loadControllerWithFixture(t);
  const res = createMockRes();
  await clientProfileController.saveSetupData(paypalSetupReq({ paymentType: 'paypal', paypalPayoutEmail: 'Pay@Example.com' }), res, () => {});

  assert.equal(res.statusCode, 200);
  const s = getClientProfileState();
  assert.equal(s.paypalPayoutEmail, 'pay@example.com');
  assert.equal(s.paymentType, 'paypal');
  assert.equal(s.iban, undefined);
  assert.equal(s.accountHolder, undefined);
  assert.equal(s.bankName, null); // untouched fixture value
});

test('client saveSetupData: PayPal inferred from email alone (no paymentType)', async (t) => {
  const { clientProfileController, getClientProfileState } = await loadControllerWithFixture(t);
  const res = createMockRes();
  await clientProfileController.saveSetupData(paypalSetupReq({ paypalPayoutEmail: 'a@b.co' }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(getClientProfileState().paypalPayoutEmail, 'a@b.co');
});

test('client saveSetupData: invalid PayPal email is rejected with 400', async (t) => {
  const { clientProfileController, clientUpdateSpy } = await loadControllerWithFixture(t);
  const res = createMockRes();
  await clientProfileController.saveSetupData(paypalSetupReq({ paymentType: 'paypal', paypalPayoutEmail: 'bad' }), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(clientUpdateSpy.mock.callCount(), 0);
});

test('client saveSetupData: paymentType=paypal with a missing email is rejected', async (t) => {
  const { clientProfileController } = await loadControllerWithFixture(t);
  const res = createMockRes();
  await clientProfileController.saveSetupData(paypalSetupReq({ paymentType: 'paypal' }), res, () => {});
  assert.equal(res.statusCode, 400);
});

test('client getSetupData (GET /client/profile/setup) returns paypalPayoutEmail, the completion and what is missing', async (t) => {
  const row = { userId: 'user-1', paymentType: 'paypal', paypalPayoutEmail: 'pay@example.com', completionPercentage: 0 };
  const updateSpy = t.mock.fn((args: any) => ({ id: 'cp-1', ...args.data }));
  t.mock.module('../config/db', { namedExports: { prisma: {
    clientProfile: { findUnique: async () => row, update: updateSpy },
    user: { findUnique: async () => ({ firstName: 'سارة', lastName: 'أحمد', avatarUrl: null, accountType: 'CLIENT_INDIVIDUAL', idNumber: null }) },
  } } });
  const { clientProfileController } = await import(`./client-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const res = createMockRes();
  await clientProfileController.getSetupData({ user: { userId: 'user-1' } } as any, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.paypalPayoutEmail, 'pay@example.com');
  assert.equal('paymentType' in res.body.data, false); // legacy bank columns are never returned
  // name 15 + PayPal 20 = 35; the rest is listed as missing (individual rules, wizard items point at the setup page)
  assert.equal(res.body.data.completionPercentage, 35);
  assert.deepEqual(res.body.data.missingItems.map((i: any) => i.key), ['avatar', 'bio', 'industry', 'idNumber']);
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.completionPercentage, 35); // stale stored value is healed
});
