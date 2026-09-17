import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// provider-profile.service.ts transitively imports notification.service.ts ->
// ../socket, which constructs `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`
// eagerly at module load. Since '../config/db' (and its dotenv.config() call)
// is fully mocked below and never actually runs, OPENAI_API_KEY is otherwise
// unset in this test process — set a dummy value so that unrelated,
// module-level construction doesn't throw. No OpenAI call is ever made by
// updateBasicInfo() itself. Same established pattern as
// account-management.service.test.ts's JWT_SECRET line, for the same reason.
process.env.OPENAI_API_KEY = 'test-key';

// Phase 3D.1: updateBasicInfo() used to write firstName/lastName/avatarUrl
// onto a NESTED `user: { update: {...} } }` inside its providerProfile.update
// call — i.e. onto the shared legacy User row, which would have silently
// changed the same identity's visible CLIENT/AFFILIATE name too. These
// fields now write directly onto ProviderProfile's own Phase 3A columns.
// This test runs against a fully mocked prisma client (mock.module
// intercepts '../config/db' and './account-logs.service' before
// provider-profile.service.ts is imported, so the real db.ts — which opens a
// pg Pool — never executes and no database connection is ever made).

const baseUser = {
  id: 'user-1',
  email: 'provider@example.com',
  phoneNumber: '0500000000',
  firstName: 'LegacyFirst',
  lastName: 'LegacyLast',
  avatarUrl: 'https://legacy.example/avatar.png',
  ibanNumber: null,
  idDocumentUrl: null
};

async function loadProviderProfileServiceWithFixture(t: TestContext) {
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

  const providerProfileUpdateSpy = t.mock.fn((args: any) => {
    providerProfileState = { ...providerProfileState, ...args.data };
    return { ...providerProfileState, user: baseUser };
  });
  const userUpdateSpy = t.mock.fn((args: any) => ({ ...baseUser, ...args.data }));
  const clientUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));
  const clientUpdateSpy = t.mock.fn((args: any) => ({ ...args.data }));
  const affiliateUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));

  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        providerProfile: {
          findUnique: async () => ({ ...providerProfileState, user: baseUser }),
          create: async () => ({ ...providerProfileState, user: baseUser }),
          update: async (args: any) => providerProfileUpdateSpy(args)
        },
        user: {
          update: async (args: any) => userUpdateSpy(args)
        },
        // Never touched by updateBasicInfo — only present here so the
        // role-isolation regression test below can assert callCount() === 0.
        clientProfile: { upsert: clientUpsertSpy, update: clientUpdateSpy },
        affiliateProfile: { upsert: affiliateUpsertSpy },
        profileModificationRequest: {
          create: async () => ({})
        },
        accountAuditLog: {
          create: async () => ({})
        },
        // Only the array form is used by updateBasicInfo — the operations
        // inside the array are already in-flight promises by the time
        // $transaction receives them (Prisma's real API works the same way).
        $transaction: async (ops: any) => Promise.all(ops)
      }
    }
  });

  t.mock.module('./account-logs.service', {
    namedExports: {
      accountAuditLogService: { record: async () => ({}) }
    }
  });

  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return {
    providerProfileService, providerProfileUpdateSpy, userUpdateSpy, clientUpsertSpy, clientUpdateSpy, affiliateUpsertSpy,
    getProviderProfileState: () => providerProfileState
  };
}

test('updateBasicInfo: firstName/lastName/avatarUrl are written to ProviderProfile, never to the legacy User row', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, getProviderProfileState } =
    await loadProviderProfileServiceWithFixture(t);

  await providerProfileService.updateBasicInfo('user-1', {
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: 'https://new.example/provider-avatar.png',
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني'
  });

  // The main providerProfile.update call must carry the display fields
  // directly (not nested under `user`).
  assert.equal(providerProfileUpdateSpy.mock.callCount() >= 1, true);
  const mainCall = providerProfileUpdateSpy.mock.calls[0].arguments[0];
  assert.equal(mainCall.data.firstName, 'Okasha');
  assert.equal(mainCall.data.lastName, 'Expert');
  assert.equal(mainCall.data.avatarUrl, 'https://new.example/provider-avatar.png');
  assert.equal('user' in mainCall.data, false);

  // The resulting ProviderProfile row reflects the new display fields.
  assert.equal(getProviderProfileState().firstName, 'Okasha');
  assert.equal(getProviderProfileState().lastName, 'Expert');
  assert.equal(getProviderProfileState().avatarUrl, 'https://new.example/provider-avatar.png');

  // Every prisma.user.update call (the completion-percentage mirror is the
  // only one that should still fire — see Phase 3D scope note below) must
  // NEVER include firstName/lastName/avatarUrl.
  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('firstName' in call.arguments[0].data, false);
    assert.equal('lastName' in call.arguments[0].data, false);
    assert.equal('avatarUrl' in call.arguments[0].data, false);
  }
});

test('updateBasicInfo: legacy User.firstName/lastName/avatarUrl remain exactly as they were before the call', async (t) => {
  const { providerProfileService, userUpdateSpy } = await loadProviderProfileServiceWithFixture(t);

  await providerProfileService.updateBasicInfo('user-1', {
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: 'https://new.example/provider-avatar.png',
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني'
  });

  // Simulate re-reading the legacy User row after the call: since no
  // user.update call in this flow may touch firstName/lastName/avatarUrl,
  // baseUser's original values are exactly what a fresh read would still see.
  assert.equal(baseUser.firstName, 'LegacyFirst');
  assert.equal(baseUser.lastName, 'LegacyLast');
  assert.equal(baseUser.avatarUrl, 'https://legacy.example/avatar.png');

  // Phase 3D.2A follow-up: the completion-percent mirror to
  // User.profileCompletionPercent has been removed (see the dedicated tests
  // below) — prisma.user.update is no longer called by updateBasicInfo at
  // all, for any reason.
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.2A follow-up — updateBasicInfo() completion writes, mirror removed.
//
// Runtime source of truth for PROVIDER completion is
// ProviderProfile.completionPercentage, computed via the shared, extracted
// computeProviderCompletion() calculator (behavior-preserving — same
// weights/fields as before extraction). The User.profileCompletionPercent
// mirror write has now been REMOVED: the re-audit (triggered by fixing
// getPublicProfile()'s `??`-based resolution order below) found no
// remaining production consumer that still requires it — getPublicProfile
// was the only one, and it no longer prefers the User value. Phase 3D.1's
// display-field isolation tests above (lines ~95-160) already cover
// firstName/lastName/avatarUrl targeting ProviderProfile only, and continue
// to pass unchanged.
// ============================================================================

test('updateBasicInfo: real ProviderProfile completion is recalculated via the shared calculator (not a stale/hardcoded value)', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy } = await loadProviderProfileServiceWithFixture(t);

  await providerProfileService.updateBasicInfo('user-1', {
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: 'https://new.example/provider-avatar.png',
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني',
    bio: 'x'.repeat(60),
    country: 'SA',
    city: 'Riyadh'
  });

  const completionCall = providerProfileUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');
  assert.equal(completionCall.arguments[0].data.completionPercentage > 0, true);
});

test('updateBasicInfo: ProviderProfile.completionPercentage (the runtime source of truth) reflects the new score', async (t) => {
  const { providerProfileService, getProviderProfileState } = await loadProviderProfileServiceWithFixture(t);

  await providerProfileService.updateBasicInfo('user-1', {
    firstName: 'Okasha',
    lastName: 'Expert',
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني'
  });

  assert.equal(typeof getProviderProfileState().completionPercentage, 'number');
  assert.equal(getProviderProfileState().completionPercentage > 0, true);
});

test('updateBasicInfo: does NOT write User.profileCompletionPercent (mirror removed after re-audit confirmed no remaining consumer)', async (t) => {
  const { providerProfileService, userUpdateSpy } = await loadProviderProfileServiceWithFixture(t);

  await providerProfileService.updateBasicInfo('user-1', {
    firstName: 'Okasha',
    lastName: 'Expert',
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني'
  });

  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('role isolation: updateBasicInfo (PROVIDER) never touches ClientProfile/AffiliateProfile', async (t) => {
  const { providerProfileService, clientUpsertSpy, clientUpdateSpy, affiliateUpsertSpy } = await loadProviderProfileServiceWithFixture(t);

  await providerProfileService.updateBasicInfo('user-1', {
    firstName: 'Okasha',
    lastName: 'Expert',
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني'
  });

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(clientUpdateSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.2A follow-up — getPublicProfile() completion resolution order.
//
// Previously: `profile.user?.profileCompletionPercent || profile.completionPercentage || 0`
// wrongly preferred the legacy User value AND treated a real 0 as falsy.
// Now: `profile.completionPercentage ?? profile.user?.profileCompletionPercent ?? 0`
// — ProviderProfile wins, with nullish (not falsy) checks so a genuine 0 is
// never masked. These tests exercise getPublicProfile() end-to-end against a
// minimal mocked prisma client (no completed projects/reviews, so
// generateAiMetrics() takes its zero-projects short-circuit and never
// constructs/calls OpenAI).
// ============================================================================

function createPublicProfileMockPrisma(t: TestContext, opts: { providerCompletion: number | null | undefined; legacyUserCompletion: number }) {
  const profileFixture: any = {
    userId: 'user-1',
    isVerified: false,
    location: null,
    city: 'Riyadh',
    rating: 5.0,
    headline: 'Senior Consultant',
    bio: 'bio',
    yearsOfExperience: 3,
    completionPercentage: opts.providerCompletion,
    githubUrl: null,
    linkedinUrl: null,
    websiteUrl: null,
    skills: [],
    portfolioItems: [],
    providerSpecialties: [],
    user: {
      firstName: 'Okasha',
      lastName: 'Expert',
      email: 'provider@example.com',
      avatarUrl: null,
      phoneNumber: '0500000000',
      createdAt: new Date('2024-01-01'),
      currentLevel: 'مستكشف - المستوى 1',
      ratingAverage: 0,
      profileCompletionPercent: opts.legacyUserCompletion
    }
  };

  const prismaMock = {
    providerProfile: { findUnique: async () => ({ ...profileFixture }) },
    project: { count: async () => 0 },
    serviceCatalog: { findMany: async () => [] },
    review: { findMany: async () => [], count: async () => 0 },
    providerGamification: { findUnique: async () => null }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
}

async function loadServiceForPublicProfile(t: TestContext, opts: { providerCompletion: number | null | undefined; legacyUserCompletion: number }) {
  createPublicProfileMockPrisma(t, opts);
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return providerProfileService;
}

test('getPublicProfile: ProviderProfile.completionPercentage (65) wins over legacy User.profileCompletionPercent (100)', async (t) => {
  const providerProfileService = await loadServiceForPublicProfile(t, { providerCompletion: 65, legacyUserCompletion: 100 });

  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.levelInfo.completionPercentage, 65);
});

test('getPublicProfile: ProviderProfile.completionPercentage = 0 is NOT replaced by legacy User.profileCompletionPercent = 100', async (t) => {
  const providerProfileService = await loadServiceForPublicProfile(t, { providerCompletion: 0, legacyUserCompletion: 100 });

  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.levelInfo.completionPercentage, 0);
});

test('getPublicProfile: falls back to legacy User.profileCompletionPercent only when ProviderProfile.completionPercentage is genuinely null/undefined', async (t) => {
  // ProviderProfile.completionPercentage is `Int @default(0)` (non-nullable)
  // in the real schema, so this state cannot occur once a row exists — this
  // test exercises the defensive `??` fallback branch itself, not a reachable
  // production state.
  const providerProfileService = await loadServiceForPublicProfile(t, { providerCompletion: undefined, legacyUserCompletion: 100 });

  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.levelInfo.completionPercentage, 100);
});

test('getPublicProfile: falls back to 0 when both ProviderProfile and legacy User completion are missing', async (t) => {
  const providerProfileService = await loadServiceForPublicProfile(t, { providerCompletion: undefined, legacyUserCompletion: undefined as any });

  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.levelInfo.completionPercentage, 0);
});
