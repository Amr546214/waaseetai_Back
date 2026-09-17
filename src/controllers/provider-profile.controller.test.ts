import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// provider-profile.controller.ts imports providerProfileService, which
// transitively imports notification.service -> ../socket, which constructs
// `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` eagerly at module load.
// Same established pattern as provider-profile.service.test.ts.
process.env.OPENAI_API_KEY = 'test-key';

// Phase 3D.2A: saveSetupData() used to unconditionally write
// User.profileCompletionPercent = 100 as part of `status: 'ACTIVE'` write.
// It must now write a real, calculated ProviderProfile.completionPercentage
// (from the FINAL post-write state, including portfolio items) and must
// never write User.profileCompletionPercent at all. User.status = 'ACTIVE'
// must still be written (unrelated identity/activation behavior, preserved).

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function createSetupDataMockPrisma(t: TestContext) {
  let providerProfileState: any = {
    id: 'pp-1',
    userId: 'user-1',
    firstName: null,
    lastName: null,
    avatarUrl: null,
    headline: null,
    bio: null,
    mainSpecialty: null,
    country: null,
    city: null,
    websiteUrl: null,
    skills: [],
    portfolioItems: [],
    completionPercentage: 0
  };
  const userFixture = {
    id: 'user-1',
    email: 'provider@example.com',
    phoneNumber: '0500000000',
    firstName: 'Legacy',
    lastName: 'Name',
    avatarUrl: null,
    ibanNumber: 'SA00...',
    idDocumentUrl: 'https://example.com/id.pdf',
    profileCompletionPercent: 0
  };

  const providerProfileUpdateSpy = t.mock.fn((args: any) => {
    providerProfileState = { ...providerProfileState, ...args.data };
    return { ...providerProfileState };
  });
  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));

  const prismaMock = {
    providerProfile: {
      upsert: t.mock.fn((args: any) => {
        providerProfileState = { ...providerProfileState, ...args.update };
        return { ...providerProfileState };
      }),
      findUnique: async () => ({ ...providerProfileState }),
      update: providerProfileUpdateSpy
    },
    portfolioItem: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async (args: any) => {
        providerProfileState.portfolioItems = [...(providerProfileState.portfolioItems || []), ...args.data];
        return { count: args.data.length };
      }
    },
    user: {
      findUnique: async () => ({ ...userFixture }),
      update: userUpdateSpy
    },
    $transaction: async (ops: any) => Promise.all(ops)
  };

  return { prismaMock, providerProfileUpdateSpy, userUpdateSpy, getProviderProfileState: () => providerProfileState };
}

async function loadControllerWithFixture(t: TestContext) {
  const mocks = createSetupDataMockPrisma(t);
  t.mock.module('../config/db', {
    namedExports: { prisma: mocks.prismaMock }
  });
  const moduleUrl = `./provider-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const controller = await import(moduleUrl);
  return { controller, ...mocks };
}

test('provider saveSetupData: writes a real calculated ProviderProfile.completionPercentage, not User=100', async (t) => {
  const { controller, providerProfileUpdateSpy } = await loadControllerWithFixture(t);

  const req: any = {
    user: { id: 'user-1' },
    body: {
      details: { idNumber: '1234567890', country: 'SA', city: 'Riyadh', occupation: 'دعم فني', bio: 'x'.repeat(60) },
      identity: {},
      bank: {},
      documents: {},
      agreements: {},
      specialties: { mainSpec: 'دعم فني' }
    }
  };
  const res = createMockRes();

  await controller.saveSetupData(req, res);

  assert.equal(res.statusCode, 200);
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
  const writtenCompletion = completionCalls[0].arguments[0].data.completionPercentage;
  assert.equal(typeof writtenCompletion, 'number');
  assert.equal(writtenCompletion > 0, true);
});

test('provider saveSetupData: never writes User.profileCompletionPercent', async (t) => {
  const { controller, userUpdateSpy } = await loadControllerWithFixture(t);

  const req: any = {
    user: { id: 'user-1' },
    body: {
      details: {},
      identity: {},
      bank: {},
      documents: {},
      agreements: {},
      specialties: {}
    }
  };
  const res = createMockRes();

  await controller.saveSetupData(req, res);

  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('profileCompletionPercent' in call.arguments[0].data, false);
  }
});

test('provider saveSetupData: preserves existing User.status = ACTIVE write', async (t) => {
  const { controller, userUpdateSpy } = await loadControllerWithFixture(t);

  const req: any = {
    user: { id: 'user-1' },
    body: {
      details: {},
      identity: {},
      bank: {},
      documents: {},
      agreements: {},
      specialties: {}
    }
  };
  const res = createMockRes();

  await controller.saveSetupData(req, res);

  const statusCall = userUpdateSpy.mock.calls.find((c: any) => c.arguments[0].data.status === 'ACTIVE');
  assert.notEqual(statusCall, undefined);
});
