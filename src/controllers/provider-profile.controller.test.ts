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

  const updateManyCalls: any[] = [];
  const providerProfileUpdateSpy = t.mock.fn((args: any) => {
    providerProfileState = { ...providerProfileState, ...args.data };
    return { ...providerProfileState };
  });
  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));

  const prismaMock = {
    providerProfile: {
      upsert: t.mock.fn((args: any) => {
        // Prisma semantics: an undefined field is left alone (it never erases the stored value)
        providerProfileState = { ...providerProfileState, ...Object.fromEntries(Object.entries(args.update).filter(([, v]) => v !== undefined)) };
        return { ...providerProfileState };
      }),
      findUnique: async () => ({ ...providerProfileState }),
      update: providerProfileUpdateSpy,
      updateMany: async (args: any) => { updateManyCalls.push(args); const hit = args.where?.kycStatus?.in?.includes(providerProfileState.kycStatus ?? 'UNVERIFIED') && args.where?.frontIdUrl?.not === null ? !!providerProfileState.frontIdUrl : false; if (hit) providerProfileState = { ...providerProfileState, ...args.data }; return { count: hit ? 1 : 0 }; }
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

  return { prismaMock, providerProfileUpdateSpy, userUpdateSpy, updateManyCalls, getProviderProfileState: () => providerProfileState };
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

// AUD-FND-000036: replaces the old "preserves existing User.status = ACTIVE write" test — that write let a suspended-for-review provider
// reactivate itself by saving the wizard, so the wizard must never write User.status.
test('provider saveSetupData: never writes User.status (the wizard cannot reactivate an account)', async (t) => {
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

  const statusCall = userUpdateSpy.mock.calls.find((c: any) => 'status' in c.arguments[0].data);
  assert.equal(statusCall, undefined);
});

// Phase 3 Batch 2A — F28: this catch block used to hardcode res.status(500)
// regardless of the thrown error's real statusCode. It must now honor
// AppError(404) for an unknown provider, and must not regress any other
// error's real status. The service itself is mocked directly here (its own
// AppError(404) behavior is proven separately in
// provider-profile.service.test.ts) — this test isolates the controller's
// error-handling contract only.
test('getPublicProfile: an unknown provider (public route) responds with the real 404, not a hardcoded 500', async (t) => {
  const { AppError } = await import('../utils/app-error');
  t.mock.module('../services/provider-profile.service', {
    namedExports: {
      providerProfileService: {
        getPublicProfile: async () => { throw new AppError('Provider not found', 404); }
      }
    }
  });
  const moduleUrl = `./provider-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const controller = await import(moduleUrl);

  const req: any = { params: { providerId: 'nonexistent-provider' }, user: undefined };
  const res = createMockRes();

  await controller.getPublicProfile(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Provider not found');
});

test('getPublicProfile: an unrelated non-AppError failure still responds with 500 (no regression)', async (t) => {
  t.mock.module('../services/provider-profile.service', {
    namedExports: {
      providerProfileService: {
        getPublicProfile: async () => { throw new Error('unexpected DB failure'); }
      }
    }
  });
  const moduleUrl = `./provider-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const controller = await import(moduleUrl);

  const req: any = { params: { providerId: 'some-provider' }, user: undefined };
  const res = createMockRes();

  await controller.getPublicProfile(req, res);

  assert.equal(res.statusCode, 500);
});

// ── the profile photo chosen in the setup wizard is stored (one canonical column), never only shown ──
const setupBody = (extra: any = {}) => ({
  details: { country: 'SA', city: 'Riyadh', occupation: 'مصمم', bio: 'x'.repeat(60) }, identity: {}, bank: {}, documents: {}, agreements: {}, specialties: { mainSpec: 'تصميم' }, ...extra,
});

test('provider saveSetupData: the uploaded photo (our own storage URL) is written to ProviderProfile.avatarUrl and the completion counts it', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  const url = 'https://res.cloudinary.com/demo/image/upload/v1/waseetai/providers/user-1/documents/me.jpg';
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: url }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(getProviderProfileState().avatarUrl, url);
});

test('provider saveSetupData: a foreign / invalid photo URL is a 400 and NOTHING is saved (no "saved" for a photo that was not stored)', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: 'https://evil.example.com/a.jpg' }) } as any, res);
  assert.equal(res.statusCode, 400);
  assert.equal(getProviderProfileState().avatarUrl ?? null, null);
});

test('provider saveSetupData: a re-save without a photo keeps the stored one (never erases it)', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  const url = 'https://res.cloudinary.com/demo/image/upload/v1/waseetai/users/user-1/avatar/avatar.jpg';
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: url }) } as any, createMockRes());
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody() } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(getProviderProfileState().avatarUrl, url);
});

test('provider saveSetupData: the date of birth is stored (ProviderProfile.dob) and a re-save without it keeps it', async (t) => {
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ details: { country: 'SA', city: 'Riyadh', occupation: 'مصمم', bio: 'x'.repeat(60), dob: '1990-05-17' } }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(new Date(getProviderProfileState().dob).toISOString().slice(0, 10), '1990-05-17');
  const res2 = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody() } as any, res2);
  assert.equal(new Date(getProviderProfileState().dob).toISOString().slice(0, 10), '1990-05-17');
});

test('provider saveSetupData: an invalid or future date of birth is a 400 and nothing is saved', async (t) => {
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  for (const dob of ['not-a-date', '2999-01-01', '1800-01-01']) {
    const res = createMockRes();
    await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ details: { country: 'SA', city: 'Riyadh', occupation: 'x', bio: 'y'.repeat(60), dob } }) } as any, res);
    assert.equal(res.statusCode, 400, dob);
  }
  assert.equal(getProviderProfileState().dob ?? null, null);
});

test('round trip: the photo saved in the setup is what the completion counts, so the "الصورة الشخصية" item is no longer missing (and is missing without it)', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const url = 'https://res.cloudinary.com/demo/image/upload/v1/waseetai/users/user-1/avatar/avatar.jpg';
  const { computeProviderMissingItems } = await import('../utils/completion-calculators');
  const withPhoto = await loadControllerWithFixture(t);
  await withPhoto.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: url }) } as any, createMockRes());
  const stored = withPhoto.getProviderProfileState();
  assert.equal(stored.avatarUrl, url);
  assert.equal(computeProviderMissingItems({ providerProfile: { ...stored, skills: [], portfolioItems: [] }, user: {} } as any).some((i: any) => i.key === 'avatar'), false);
  assert.equal(computeProviderMissingItems({ providerProfile: { ...stored, avatarUrl: null, skills: [], portfolioItems: [] }, user: {} } as any).some((i: any) => i.key === 'avatar'), true);
});


// ── identity documents sent in the setup: ONE review lifecycle (NOT_SUBMITTED -> PENDING_REVIEW -> APPROVED | REJECTED), never "stored but not submitted" ──
const USER_REF = (name: string) => `private:image:png:waseetai/providers/user-1/identity/${name}`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
async function loadWithKyc(t: TestContext, state: any = {}) {
  t.mock.module('../utils/cloudinary-storage', { namedExports: {
    storeDataUriIfNeeded: async (v: any) => v, ensureCloudinaryUrl: async (v: any) => v,
    storeKycFileIfNeeded: async (v: any, _folder: string, name: string) => (typeof v === 'string' && v.startsWith('data:') ? USER_REF(`${name}-new`) : v),
  } });
  const x = await loadControllerWithFixture(t);
  await x.prismaMock.providerProfile.upsert({ update: { userId: 'user-1', ...state } } as any);
  return x;
}

test('setup: the front of the ID uploaded in the wizard is a complete submission: kycStatus UNVERIFIED -> PENDING (no ID number or back needed)', async (t) => {
  const x = await loadWithKyc(t);
  const res = createMockRes();
  await x.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: PNG } }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(x.getProviderProfileState().kycStatus, 'PENDING');
  assert.equal(x.getProviderProfileState().frontIdUrl, USER_REF('front-id-new'));
});

test('setup: a REJECTED identity re-sent in the wizard goes back to PENDING (re-submission)', async (t) => {
  const x = await loadWithKyc(t, { kycStatus: 'REJECTED', frontIdUrl: USER_REF('old') });
  const res = createMockRes();
  await x.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: PNG } }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(x.getProviderProfileState().kycStatus, 'PENDING');
});

test('setup: a NEW document while the previous one is still PENDING is a 409 and nothing is saved (no duplicate request)', async (t) => {
  const x = await loadWithKyc(t, { kycStatus: 'PENDING', frontIdUrl: USER_REF('first') });
  const res = createMockRes();
  await x.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: PNG } }) } as any, res);
  assert.equal(res.statusCode, 409);
  assert.equal(x.getProviderProfileState().frontIdUrl, USER_REF('first'));
  assert.equal(x.getProviderProfileState().kycStatus, 'PENDING');
});

test('setup: re-saving the wizard with the SAME stored document while PENDING is fine (200) and changes nothing', async (t) => {
  const x = await loadWithKyc(t, { kycStatus: 'PENDING', frontIdUrl: USER_REF('first') });
  const res = createMockRes();
  await x.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: USER_REF('first') } }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(x.getProviderProfileState().kycStatus, 'PENDING');
  assert.equal(x.getProviderProfileState().frontIdUrl, USER_REF('first'));
});

test('setup: a VERIFIED identity is never downgraded by a re-save', async (t) => {
  const x = await loadWithKyc(t, { kycStatus: 'VERIFIED', frontIdUrl: USER_REF('first') });
  const res = createMockRes();
  await x.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: USER_REF('first') } }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(x.getProviderProfileState().kycStatus, 'VERIFIED');
});

// ── G4 (file-link rejection): a value the user already has stored, echoed back unchanged, is "keep" — never re-validated as a new link ──
const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocLabcDEF=s96-c';
const FOREIGN_MSG = 'رابط الملف غير مسموح به؛ ارفع الملف مباشرة من الجهاز';

test('G4 provider saveSetupData: the stored Google sign-in photo echoed back unchanged is accepted and kept (was a 400 «رابط الملف غير مسموح به»)', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  getProviderProfileState().avatarUrl = GOOGLE_PHOTO; // the real DEV shape: ProviderProfile.avatarUrl = lh3.googleusercontent.com/...
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: GOOGLE_PHOTO }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(getProviderProfileState().avatarUrl, GOOGLE_PHOTO);
});

test('G4 provider saveSetupData: a DIFFERENT external photo link is still refused with the same message, and so is a replaced-by-foreign value when a Google photo is stored', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  getProviderProfileState().avatarUrl = GOOGLE_PHOTO;
  for (const bad of ['https://lh3.googleusercontent.com/a/OTHER=s96-c', 'https://evil.example.com/a.jpg', 'https://res.cloudinary.com/other-cloud/image/upload/v1/x.jpg', 'http://res.cloudinary.com/demo/image/upload/v1/x.jpg']) {
    const res = createMockRes();
    await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: bad }) } as any, res);
    assert.equal(res.statusCode, 400, bad);
  }
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: 'https://evil.example.com/a.jpg' }) } as any, res);
  assert.equal(res.statusCode, 400);
  assert.equal(getProviderProfileState().avatarUrl, GOOGLE_PHOTO);
  assert.match(JSON.stringify(res.body), /رابط الملف غير مسموح به/);
});

test('G4 provider saveSetupData: replacing the photo (direct upload → our storage URL) over a stored Google photo works', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const { controller, getProviderProfileState } = await loadControllerWithFixture(t);
  getProviderProfileState().avatarUrl = GOOGLE_PHOTO;
  const url = 'https://res.cloudinary.com/demo/image/upload/v1/waseetai/users/user-1/avatar/avatar.jpg';
  const res = createMockRes();
  await controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ avatarUrl: url }) } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(getProviderProfileState().avatarUrl, url);
});

test('G4 provider saveSetupData: a legacy identity value stored as a bare file name, re-sent unchanged, is kept', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const legacy = 'IMG20260101_1234.jpg';
  const a = await loadControllerWithFixture(t);
  a.getProviderProfileState().frontIdUrl = legacy;
  const ok = createMockRes();
  await a.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: legacy } }) } as any, ok);
  assert.equal(ok.statusCode, 200);
});

test('G4 provider saveSetupData: the same bare value for an account that does not have it stored is refused (400)', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  const b = await loadControllerWithFixture(t);
  const bad = createMockRes();
  await b.controller.saveSetupData({ user: { id: 'user-1' }, body: setupBody({ identity: { frontId: 'IMG20260101_1234.jpg' } }) } as any, bad);
  assert.equal(bad.statusCode, 400);
});
