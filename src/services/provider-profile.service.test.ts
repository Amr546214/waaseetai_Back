import { test, TestContext } from 'node:test';

// KYC document values must live inside our own Cloudinary account (or be an owned private reference).
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// provider-profile.service.ts transitively imports notification.service.ts ->
// ../socket -> avatar-chat.gateway.ts -> openai-tts.client.ts, which
// constructs `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` eagerly at
// module load (F8-TTS, intentionally not migrated to Gemini this batch — see
// the migration report). Since '../config/db' is fully mocked below and
// never actually runs, OPENAI_API_KEY is otherwise unset in this test
// process — set a dummy value so that unrelated, module-level construction
// doesn't throw. No OpenAI call is ever made by anything in this file.
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
          create: async () => ({}),
          count: async () => 0
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
  // (getProfile may first sync the stored completionPercentage with its own update call, so pick the call carrying the fields.)
  const mainCall = providerProfileUpdateSpy.mock.calls.map((c: any) => c.arguments[0]).find((a: any) => 'firstName' in a.data);
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

function createPublicProfileMockPrisma(t: TestContext, opts: {
  providerCompletion: number | null | undefined;
  legacyUserCompletion: number;
  providerFirstName?: string | null;
  providerLastName?: string | null;
  providerAvatarUrl?: string | null;
  userFirstName?: string | null;
  userLastName?: string | null;
  userAvatarUrl?: string | null;
}) {
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
    firstName: opts.providerFirstName ?? null,
    lastName: opts.providerLastName ?? null,
    avatarUrl: opts.providerAvatarUrl ?? null,
    githubUrl: null,
    linkedinUrl: null,
    websiteUrl: null,
    skills: [],
    portfolioItems: [],
    providerSpecialties: [],
    user: {
      firstName: opts.userFirstName ?? 'Okasha',
      lastName: opts.userLastName ?? 'Expert',
      email: 'provider@example.com',
      avatarUrl: opts.userAvatarUrl ?? null,
      phoneNumber: '0500000000',
      createdAt: new Date('2024-01-01'),
      currentLevel: 'مستكشف - المستوى 1',
      ratingAverage: 0,
      profileCompletionPercent: opts.legacyUserCompletion
    }
  };

  const clientProfileSpy = t.mock.fn();
  const affiliateProfileSpy = t.mock.fn();

  const prismaMock = {
    providerProfile: { findUnique: async () => ({ ...profileFixture }) },
    project: { count: async () => 0 },
    serviceCatalog: { findMany: async () => [] },
    review: { findMany: async () => [], count: async () => 0 },
    providerGamification: { findUnique: async () => null },
    // Never touched by getPublicProfile — present only so cross-role
    // isolation tests can assert callCount() === 0.
    clientProfile: { findUnique: clientProfileSpy, update: clientProfileSpy },
    affiliateProfile: { findUnique: affiliateProfileSpy, update: affiliateProfileSpy }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });

  return { clientProfileSpy, affiliateProfileSpy };
}

async function loadServiceForPublicProfile(t: TestContext, opts: Parameters<typeof createPublicProfileMockPrisma>[1]) {
  createPublicProfileMockPrisma(t, opts);
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return providerProfileService;
}

// Phase 3 Batch 2A — F28: getPublicProfile used to throw a plain Error on a
// missing provider, which the controller's catch block turned into a 500.
// It must now throw the project's real AppError(404) contract.
test('getPublicProfile: an unknown provider throws AppError with statusCode 404 (not a plain Error / 500)', async (t) => {
  t.mock.module('../config/db', { namedExports: { prisma: { providerProfile: { findUnique: async () => null } } } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);

  await assert.rejects(
    () => providerProfileService.getPublicProfile('nonexistent-provider'),
    (err: any) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.message, 'Provider not found');
      return true;
    }
  );
});

async function loadServiceForPublicProfileWithSpies(t: TestContext, opts: Parameters<typeof createPublicProfileMockPrisma>[1]) {
  const spies = createPublicProfileMockPrisma(t, opts);
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return { providerProfileService, ...spies };
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

// ============================================================================
// Phase 3E.1 — getPublicProfile() Provider display identity fix.
//
// header.fullName/avatarUrl and basicInfo.fullName previously read the raw,
// shared User.firstName/lastName/avatarUrl even when ProviderProfile had its
// own independent Phase 3A/3D.1 display columns — meaning a provider who set
// a Provider-specific name/avatar via updateBasicInfo never saw it reflected
// on their own public profile page. Now ProviderProfile wins, User is only a
// fallback for a null/empty value.
// ============================================================================

test('getPublicProfile: ProviderProfile display identity wins over legacy User identity', async (t) => {
  const providerProfileService = await loadServiceForPublicProfile(t, {
    providerCompletion: 65,
    legacyUserCompletion: 100,
    providerFirstName: 'Provider',
    providerLastName: 'Persona',
    providerAvatarUrl: 'https://provider.example/avatar.png',
    userFirstName: 'Legacy',
    userLastName: 'Name',
    userAvatarUrl: 'https://legacy.example/avatar.png'
  });

  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.fullName, 'Provider Persona');
  assert.equal(result.header.avatarUrl, 'https://provider.example/avatar.png');
  assert.equal(result.basicInfo.fullName, 'Provider Persona');
});

test('getPublicProfile: falls back to legacy User identity when ProviderProfile display fields are missing', async (t) => {
  const providerProfileService = await loadServiceForPublicProfile(t, {
    providerCompletion: 65,
    legacyUserCompletion: 100,
    providerFirstName: null,
    providerLastName: null,
    providerAvatarUrl: null,
    userFirstName: 'Legacy',
    userLastName: 'Name',
    userAvatarUrl: 'https://legacy.example/avatar.png'
  });

  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.fullName, 'Legacy Name');
  assert.equal(result.header.avatarUrl, 'https://legacy.example/avatar.png');
  assert.equal(result.basicInfo.fullName, 'Legacy Name');
});

test('getPublicProfile: returns the Provider-specific name regardless of any viewer-activeRole assumption (endpoint takes only a providerId, never a viewer role)', async (t) => {
  const providerProfileService = await loadServiceForPublicProfile(t, {
    providerCompletion: 65,
    legacyUserCompletion: 100,
    providerFirstName: 'Provider',
    providerLastName: 'Persona',
    providerAvatarUrl: 'https://provider.example/avatar.png'
  });

  // getPublicProfile's signature takes only a providerId — there is no
  // viewer/activeRole parameter for it to depend on at all, so calling it
  // identically always resolves the SAME target provider's identity.
  const result = await providerProfileService.getPublicProfile('user-1');

  assert.equal(result.header.fullName, 'Provider Persona');
});

test('getPublicProfile: never reads or mutates ClientProfile/AffiliateProfile state', async (t) => {
  const { providerProfileService, clientProfileSpy, affiliateProfileSpy } = await loadServiceForPublicProfileWithSpies(t, {
    providerCompletion: 65,
    legacyUserCompletion: 100,
    providerFirstName: 'Provider',
    providerLastName: 'Persona'
  });

  await providerProfileService.getPublicProfile('user-1');

  assert.equal(clientProfileSpy.mock.callCount(), 0);
  assert.equal(affiliateProfileSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.2B — skills and portfolio completion mutation coverage.
//
// updateSkills/addPortfolioItem/deletePortfolioItem previously left
// ProviderProfile.completionPercentage stale after changing exactly the two
// factors computeProviderCompletion() reads from those mutations: skills
// count and portfolio-items count. updatePortfolioItem is deliberately
// excluded — it only edits an existing item's own fields, never the count or
// websiteUrl, so the formula cannot change from that call.
// ============================================================================

function createSkillsPortfolioMockPrisma(t: TestContext) {
  let providerProfileState: any = {
    id: 'pp-1',
    userId: 'user-1',
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: null,
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني',
    bio: 'x'.repeat(60),
    country: 'SA',
    city: 'Riyadh',
    websiteUrl: null,
    skills: [] as any[],
    portfolioItems: [] as any[],
    completionPercentage: 0
  };
  const userFixture = {
    id: 'user-1',
    email: 'provider@example.com',
    phoneNumber: '0500000000',
    firstName: 'Legacy',
    lastName: 'Name',
    avatarUrl: null,
    ibanNumber: 'SA5300000000000000000099',
    idDocumentUrl: 'https://res.cloudinary.com/testcloud/image/upload/id.pdf'
  };

  const skillsByName = new Map<string, { id: string; name: string }>();
  let skillSeq = 0;
  let portfolioSeq = 0;

  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));
  const providerProfileUpdateSpy = t.mock.fn((args: any) => {
    const { skills, ...rest } = args.data;
    providerProfileState = { ...providerProfileState, ...rest };
    // `skills: { set: [{id}, ...] }` is a Prisma relation instruction, not a
    // plain array — resolve it back to real skill objects (by id) so
    // providerProfileState.skills.length behaves exactly like a real re-read.
    if (skills?.set) {
      const byId = new Map([...skillsByName.values()].map(s => [s.id, s]));
      providerProfileState.skills = skills.set.map((ref: { id: string }) => byId.get(ref.id)).filter(Boolean);
    }
    return { ...providerProfileState };
  });
  const clientUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));
  const affiliateUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));

  const prismaMock = {
    providerProfile: {
      findUnique: async () => ({ ...providerProfileState, user: { ...userFixture } }),
      update: providerProfileUpdateSpy
    },
    skill: {
      upsert: t.mock.fn(async (args: any) => {
        const name = args.where.name;
        if (!skillsByName.has(name)) skillsByName.set(name, { id: `skill-${++skillSeq}`, name });
        return skillsByName.get(name)!;
      })
    },
    portfolioItem: {
      create: t.mock.fn(async (args: any) => {
        const item = { id: `item-${++portfolioSeq}`, ...args.data };
        providerProfileState.portfolioItems = [...providerProfileState.portfolioItems, item];
        return item;
      }),
      findFirst: async (args: any) =>
        providerProfileState.portfolioItems.find((i: any) => i.id === args.where.id && i.providerProfileId === args.where.providerProfileId) || null,
      update: t.mock.fn(async (args: any) => {
        providerProfileState.portfolioItems = providerProfileState.portfolioItems.map((i: any) =>
          i.id === args.where.id ? { ...i, ...args.data } : i
        );
        return providerProfileState.portfolioItems.find((i: any) => i.id === args.where.id);
      }),
      deleteMany: t.mock.fn(async (args: any) => {
        const before = providerProfileState.portfolioItems.length;
        providerProfileState.portfolioItems = providerProfileState.portfolioItems.filter(
          (i: any) => !(i.id === args.where.id && i.providerProfileId === args.where.providerProfileId)
        );
        return { count: before - providerProfileState.portfolioItems.length };
      })
    },
    user: { update: userUpdateSpy },
    clientProfile: { upsert: clientUpsertSpy },
    affiliateProfile: { upsert: affiliateUpsertSpy }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });

  return {
    userUpdateSpy, providerProfileUpdateSpy, clientUpsertSpy, affiliateUpsertSpy,
    getProviderProfileState: () => providerProfileState
  };
}

async function loadServiceForSkillsPortfolio(t: TestContext) {
  const mocks = createSkillsPortfolioMockPrisma(t);
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return { providerProfileService, ...mocks };
}

test('updateSkills: 0 -> >=1 skills recalculates completion (skills factor now scored)', async (t) => {
  const { providerProfileService, getProviderProfileState } = await loadServiceForSkillsPortfolio(t);

  const before = getProviderProfileState().completionPercentage;
  await providerProfileService.updateSkills('user-1', ['Node.js', 'React']);

  assert.equal(getProviderProfileState().skills.length, 2);
  assert.equal(getProviderProfileState().completionPercentage > before, true);
});

test('updateSkills: writes ProviderProfile.completionPercentage', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy } = await loadServiceForSkillsPortfolio(t);

  await providerProfileService.updateSkills('user-1', ['Node.js']);

  const completionCall = providerProfileUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');
});

test('updateSkills: never writes User.profileCompletionPercent', async (t) => {
  const { providerProfileService, userUpdateSpy } = await loadServiceForSkillsPortfolio(t);

  await providerProfileService.updateSkills('user-1', ['Node.js']);

  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('profileCompletionPercent' in call.arguments[0].data, false);
  }
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('addPortfolioItem: 0 -> 1 portfolio items recalculates completion', async (t) => {
  const { providerProfileService, getProviderProfileState } = await loadServiceForSkillsPortfolio(t);

  const before = getProviderProfileState().completionPercentage;
  assert.equal(getProviderProfileState().portfolioItems.length, 0);

  await providerProfileService.addPortfolioItem('user-1', { title: 'Project A', description: 'desc' });

  assert.equal(getProviderProfileState().portfolioItems.length, 1);
  assert.equal(getProviderProfileState().completionPercentage > before, true);
});

test('deletePortfolioItem: 1 -> 0 portfolio items recalculates completion', async (t) => {
  const { providerProfileService, getProviderProfileState } = await loadServiceForSkillsPortfolio(t);

  const created = await providerProfileService.addPortfolioItem('user-1', { title: 'Project A', description: 'desc' });
  const afterAdd = getProviderProfileState().completionPercentage;

  await providerProfileService.deletePortfolioItem('user-1', created.id);

  assert.equal(getProviderProfileState().portfolioItems.length, 0);
  assert.equal(getProviderProfileState().completionPercentage < afterAdd, true);
});

test('deletePortfolioItem: websiteUrl still satisfies the portfolio factor when count drops to 0', async (t) => {
  const { providerProfileService, getProviderProfileState } = await loadServiceForSkillsPortfolio(t);
  getProviderProfileState().websiteUrl = 'https://provider.example';

  const created = await providerProfileService.addPortfolioItem('user-1', { title: 'Project A', description: 'desc' });
  const afterAdd = getProviderProfileState().completionPercentage;

  await providerProfileService.deletePortfolioItem('user-1', created.id);

  // portfolioItems.length > 0 OR websiteUrl -> the factor stays satisfied via
  // websiteUrl alone, so the score must NOT drop even though the count did.
  assert.equal(getProviderProfileState().completionPercentage, afterAdd);
});

test('updatePortfolioItem: does not perform any completion recomputation (no scored factor can change)', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, getProviderProfileState } = await loadServiceForSkillsPortfolio(t);

  const created = await providerProfileService.addPortfolioItem('user-1', { title: 'Project A', description: 'desc' });
  providerProfileUpdateSpy.mock.resetCalls();

  await providerProfileService.updatePortfolioItem('user-1', created.id, { title: 'Renamed Project', description: 'new desc' });

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
  assert.equal(getProviderProfileState().portfolioItems[0].title, 'Renamed Project');
});

test('role isolation (skills/portfolio): never touches ClientProfile/AffiliateProfile, and User.profileCompletionPercent is never written', async (t) => {
  const { providerProfileService, clientUpsertSpy, affiliateUpsertSpy, userUpdateSpy } = await loadServiceForSkillsPortfolio(t);

  await providerProfileService.updateSkills('user-1', ['Node.js']);
  const item = await providerProfileService.addPortfolioItem('user-1', { title: 'A', description: 'd' });
  await providerProfileService.deletePortfolioItem('user-1', item.id);

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.2B — sensitive BANKING/DOCUMENTS/CONTACT completion coverage.
//
// The real commit point for BANKING/DOCUMENTS is applySensitivePayload(),
// reached via reviewSensitiveChange() (admin-approved) since both categories
// require human review (sensitiveConfig). CONTACT does not require review, so
// its commit point is verifySensitiveChange() itself. Recompute must trigger
// only when the FINAL committed updateData actually contains the one field
// each category's formula factor reads (ibanNumber / idDocumentUrl) — never
// merely because of `category`, and never for CONTACT.
// ============================================================================

function createSensitiveFlowMockPrisma(t: TestContext, opts: { throwOnRecompute?: boolean } = {}) {
  let userState: any = {
    id: 'user-1',
    email: 'provider@example.com',
    phoneNumber: '0500000000',
    alternativePhone: null,
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: null,
    accountHolderName: null,
    ibanNumber: null,
    bankName: null,
    idDocumentUrl: null,
    idNumber: null
  };
  let providerProfileState: any = {
    id: 'pp-1',
    userId: 'user-1',
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: null,
    headline: 'Senior Consultant',
    mainSpecialty: 'دعم فني',
    bio: 'x'.repeat(60),
    country: 'SA',
    city: 'Riyadh',
    websiteUrl: null,
    skills: [{ id: 's1', name: 'Node.js' }],
    portfolioItems: [],
    completionPercentage: 0,
    certUrls: [] as string[]
  };
  const requestsById: Record<string, any> = {};
  const otpsById: Record<string, any> = {};
  let requestSeq = 0;
  let otpSeq = 0;
  const callOrder: string[] = [];

  const userUpdateSpy = t.mock.fn((args: any) => {
    callOrder.push('user.update');
    userState = { ...userState, ...args.data };
    return { ...userState };
  });
  const providerProfileUpdateSpy = t.mock.fn((args: any) => {
    if ('completionPercentage' in args.data) callOrder.push('providerProfile.update:completion');
    providerProfileState = { ...providerProfileState, ...args.data };
    return { ...providerProfileState };
  });
  const loggerErrorSpy = t.mock.fn();
  const clientUpsertSpy = t.mock.fn();
  const affiliateUpsertSpy = t.mock.fn();

  const prismaMock = {
    user: {
      findUnique: async (args: any) => {
        if (args?.where?.email) return userState.email === args.where.email ? { ...userState } : null;
        if (args?.where?.phoneNumber) return userState.phoneNumber === args.where.phoneNumber ? { ...userState } : null;
        return { ...userState, providerProfile: providerProfileState };
      },
      update: userUpdateSpy
    },
    providerProfile: {
      findUnique: async () => {
        if (opts.throwOnRecompute) throw new Error('simulated DB failure during completion recompute');
        return { ...providerProfileState, user: { ...userState } };
      },
      update: providerProfileUpdateSpy
    },
    clientProfile: { upsert: clientUpsertSpy },
    affiliateProfile: { upsert: affiliateUpsertSpy },
    profileModificationRequest: {
      create: async (args: any) => {
        const id = `req-${++requestSeq}`;
        const record = { id, ...args.data };
        requestsById[id] = record;
        return record;
      },
      findFirst: async (args: any) => {
        const record = requestsById[args.where.id];
        if (!record) return null;
        if (args.where.providerId && record.providerId !== args.where.providerId) return null;
        if (args.where.status && record.status !== args.where.status) return null;
        return record;
      },
      findUnique: async (args: any) => requestsById[args.where.id] || null,
      update: async (args: any) => {
        requestsById[args.where.id] = { ...requestsById[args.where.id], ...args.data };
        return requestsById[args.where.id];
      },
      delete: async (args: any) => { const r = requestsById[args.where.id]; delete requestsById[args.where.id]; return r; }
    },
    otpVerification: {
      deleteMany: async () => ({ count: 0 }),
      create: async (args: any) => {
        const id = `otp-${++otpSeq}`;
        const record = { id, ...args.data };
        otpsById[id] = record;
        return record;
      },
      // the lookup is by purpose + requestId (the code is compared by the service); latest first
      findFirst: async (args: any) => {
        const wanted = (args.where.AND ?? []).map((c: any) => c.context.equals);
        const matches = Object.values(otpsById).filter((o: any) => o.userId === args.where.userId && o.type === args.where.type
          && o.context?.purpose === wanted[0] && o.context?.requestId === wanted[1]);
        const found: any = matches[matches.length - 1];
        return found ? { attempts: 0, ...found } : null;
      },
      update: async (args: any) => { const o: any = otpsById[args.where.id]; if (o) o.attempts = (o.attempts || 0) + 1; return o; },
      delete: async (args: any) => { delete otpsById[args.where.id]; return {}; }
    },
    accountAuditLog: { create: async () => ({}) },
    $transaction: async (ops: any) => Promise.all(ops)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
  t.mock.module('../config/logger', { namedExports: { logger: { error: loggerErrorSpy, info: () => {}, warn: () => {} } } });

  return {
    userUpdateSpy, providerProfileUpdateSpy, loggerErrorSpy, callOrder, clientUpsertSpy, affiliateUpsertSpy,
    getUserState: () => userState,
    getProviderProfileState: () => providerProfileState,
    getLastOtpCode: () => (Object.values(otpsById).slice(-1)[0] as any)?.code as string | undefined
  };
}

async function loadServiceForSensitiveFlow(t: TestContext, opts: { throwOnRecompute?: boolean } = {}) {
  const mocks = createSensitiveFlowMockPrisma(t, opts);
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return { providerProfileService, ...mocks };
}

// Security cleanup (A): the mod-97 IBAN checksum validator existed but its
// call was commented out. It is now enabled for the modern BANKING flow — a
// masked resubmission ("************1234", stripped later in
// applySensitivePayload) is exempt, since it was never meant to be a real
// IBAN value and rejecting it would break the legitimate "leave this field
// unchanged" edit-form flow.
test('initiateSensitiveChange (BANKING): rejects an IBAN that fails the mod-97 checksum', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);

  await assert.rejects(
    () => providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
      accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA0000000000000000000011'
    }),
    /INVALID_IBAN/
  );
});

test('initiateSensitiveChange (BANKING): a masked ibanNumber ("************1234") is exempt from checksum validation', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: '************1234'
  });

  assert.ok(initiated.requestId);
});

test('initiateSensitiveChange (BANKING): does not recalculate completion at initiation time', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy } = await loadServiceForSensitiveFlow(t);

  await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA5300000000000000000099'
  });

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('verifySensitiveChange (BANKING, pending human review): does not recalculate before admin approval', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA5300000000000000000099'
  });
  const verified = await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);

  assert.equal(verified.status, 'PENDING_HUMAN_REVIEW');
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('reviewSensitiveChange (BANKING, approved): recalculates completion after ibanNumber actually commits', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, callOrder, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA5300000000000000000099'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  assert.equal(ibanCommit.arguments[0].data.ibanNumber, 'SA5300000000000000000099');

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
  // The sensitive User write must commit before the completion recompute reads it.
  assert.equal(callOrder.indexOf('user.update') < callOrder.indexOf('providerProfile.update:completion'), true);
});

test('reviewSensitiveChange (BANKING, approved) with a masked ibanNumber stripped from the payload: does NOT recalculate', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: '************1234'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  // The masked value must have been stripped before commit (applySensitivePayload's
  // existing masked-value guard), so ibanNumber must not even be in the final write.
  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.equal(ibanCommit, undefined);

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('reviewSensitiveChange (DOCUMENTS, approved): recalculates completion after idDocumentUrl actually commits', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'DOCUMENTS', {
    idDocumentUrl: 'https://res.cloudinary.com/testcloud/image/upload/id.pdf'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  const docCommit = userUpdateSpy.mock.calls.find((c: any) => 'idDocumentUrl' in c.arguments[0].data);
  assert.notEqual(docCommit, undefined);

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
});

test('verifySensitiveChange (CONTACT, applied immediately since it needs no review): recomputes provider completion (email/phone are scored)', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'CONTACT', {
    email: 'new@example.com', phoneNumber: '0511111111', alternativePhone: '0522222222'
  });
  const verified = await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);

  assert.equal(verified.status, 'APPROVED');
  const emailCommit = userUpdateSpy.mock.calls.find((c: any) => 'email' in c.arguments[0].data);
  assert.notEqual(emailCommit, undefined);

  // Email/phone are completion inputs, so the CONTACT commit now recomputes the stored percentage (previously only the
  // BANKING and DOCUMENTS commit points did).
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
});

test('reviewSensitiveChange (BANKING, approved): a completion-recompute failure is logged and does not fail the already-successful sensitive change', async (t) => {
  const { providerProfileService, userUpdateSpy, loggerErrorSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t, { throwOnRecompute: true });

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA5300000000000000000099'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  const reviewed = await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  // The sensitive change itself must still succeed...
  assert.equal(reviewed.status, 'APPROVED');
  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  // ...and the recompute failure must be logged, not silently swallowed and
  // not left as an empty catch.
  assert.equal(loggerErrorSpy.mock.callCount() > 0, true);
  const loggedError = loggerErrorSpy.mock.calls[0].arguments;
  assert.match(String(loggedError[0]), /provider completion/i);
  // No IBAN/document values leaked into the log line itself.
  assert.doesNotMatch(String(loggedError[0]), /SA5300000000000000000099/);
});

// ============================================================================
// Security batch — createModificationRequest() no longer computes a fake
// `85 + Math.random() * 10` "AI confidence" that could auto-APPROVE and
// immediately mutate User.email/phoneNumber/ibanNumber/idNumber with zero
// real verification. It now always lands in PENDING_HUMAN_REVIEW, and the
// actual mutation only ever happens via reviewSensitiveChange() (admin-only,
// same real-approval gate BANKING/DOCUMENTS already use) through the new
// applyLegacyFieldModification() path. A valid mod-97 checksum IBAN
// ('SA1000000000000000000000') is used here since IBAN format validation is
// now enforced at request-creation time, reusing the pre-existing
// isValidIban() helper.
// ============================================================================

const VALID_TEST_IBAN = 'SA1000000000000000000000';

test('createModificationRequest: Math.random no longer influences the outcome — status is PENDING_HUMAN_REVIEW regardless of its value', async (t) => {
  const originalRandom = Math.random;
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);

  try {
    Math.random = () => 0.999; // would have been 85 + 9.99 = 94.99 > 92 -> old code auto-approved
    const high = await providerProfileService.createModificationRequest('user-1', {
      fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
    });
    assert.equal(high.status, 'PENDING_HUMAN_REVIEW');

    Math.random = () => 0; // would have been 85 <= 92 -> old code also left this pending
    const low = await providerProfileService.createModificationRequest('user-1', {
      fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
    });
    assert.equal(low.status, 'PENDING_HUMAN_REVIEW');
  } finally {
    Math.random = originalRandom;
  }
});

test('createModificationRequest: no AI evaluation happens — aiConfidence/aiAuditStatus/aiRecommendation are genuinely null, never fabricated', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
  });

  assert.equal(request.aiConfidence, undefined);
  assert.equal(request.aiAuditStatus, undefined);
  assert.equal(request.aiRecommendation, undefined);
});

for (const { fieldName, fieldLabel, requestedValue } of [
  { fieldName: 'EMAIL', fieldLabel: 'Email', requestedValue: 'new@example.com' },
  { fieldName: 'PHONE_NUMBER', fieldLabel: 'Phone', requestedValue: '0511111111' },
  { fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN },
  { fieldName: 'NATIONAL_ID', fieldLabel: 'National ID', requestedValue: '1234567890' }
]) {
  test(`createModificationRequest (${fieldName}): can never auto-approve — always PENDING_HUMAN_REVIEW, and User is not mutated at creation time`, async (t) => {
    const { providerProfileService, userUpdateSpy } = await loadServiceForSensitiveFlow(t);

    const request = await providerProfileService.createModificationRequest('user-1', { fieldName, fieldLabel, requestedValue });

    assert.equal(request.status, 'PENDING_HUMAN_REVIEW');
    assert.equal(userUpdateSpy.mock.callCount(), 0, 'the DB mutation must not happen before a real admin approval');
  });
}

test('createModificationRequest: rejects a malformed email before creating any request', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);
  await assert.rejects(
    () => providerProfileService.createModificationRequest('user-1', { fieldName: 'EMAIL', fieldLabel: 'Email', requestedValue: 'not-an-email' }),
    /INVALID_EMAIL/
  );
});

test('createModificationRequest: rejects a malformed phone number', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);
  await assert.rejects(
    () => providerProfileService.createModificationRequest('user-1', { fieldName: 'PHONE_NUMBER', fieldLabel: 'Phone', requestedValue: 'abc' }),
    /INVALID_PHONE/
  );
});

test('createModificationRequest: rejects an IBAN that fails the mod-97 checksum (format validation, not ownership verification)', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);
  await assert.rejects(
    () => providerProfileService.createModificationRequest('user-1', { fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: 'SA0000000000000000000099' }),
    /INVALID_IBAN/
  );
});

test('createModificationRequest: rejects an unsupported fieldName instead of silently accepting an arbitrary field', async (t) => {
  const { providerProfileService } = await loadServiceForSensitiveFlow(t);
  await assert.rejects(
    () => providerProfileService.createModificationRequest('user-1', { fieldName: 'ADMIN_ROLE', fieldLabel: 'Role', requestedValue: 'SUPER_ADMIN' }),
    /Unsupported fieldName/
  );
});

test('createModificationRequest: a client-supplied status/aiConfidence/approved in the payload has zero effect (the service only ever reads fieldName/fieldLabel/requestedValue)', async (t) => {
  const { providerProfileService, userUpdateSpy } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN,
    status: 'APPROVED', aiConfidence: 100, aiAuditStatus: 'PASSED', approved: true
  } as any);

  assert.equal(request.status, 'PENDING_HUMAN_REVIEW');
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('reviewSensitiveChange (legacy IBAN request, approved): a real admin approval applies the change and recalculates completion', async (t) => {
  const { providerProfileService, userUpdateSpy, providerProfileUpdateSpy, callOrder } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
  });
  assert.equal(userUpdateSpy.mock.callCount(), 0, 'sanity check: still unapplied before review');

  const reviewed = await providerProfileService.reviewSensitiveChange(request.id, true);

  assert.equal(reviewed.status, 'APPROVED');
  assert.equal(reviewed.reviewedByAdmin, true);
  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  assert.equal(ibanCommit.arguments[0].data.ibanNumber, VALID_TEST_IBAN);
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
  assert.equal(callOrder.indexOf('user.update') < callOrder.indexOf('providerProfile.update:completion'), true);
});

test('reviewSensitiveChange (legacy EMAIL request, approved): applies the change but does not trigger provider completion recalculation', async (t) => {
  const { providerProfileService, userUpdateSpy, providerProfileUpdateSpy } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'EMAIL', fieldLabel: 'Email', requestedValue: 'new@example.com'
  });
  const reviewed = await providerProfileService.reviewSensitiveChange(request.id, true);

  assert.equal(reviewed.status, 'APPROVED');
  const emailCommit = userUpdateSpy.mock.calls.find((c: any) => 'email' in c.arguments[0].data);
  assert.notEqual(emailCommit, undefined);
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('reviewSensitiveChange (legacy IBAN request, rejected): does not mutate User and does not recalculate completion', async (t) => {
  const { providerProfileService, userUpdateSpy, providerProfileUpdateSpy } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
  });
  const reviewed = await providerProfileService.reviewSensitiveChange(request.id, false, 'بيانات غير مطابقة');

  assert.equal(reviewed.status, 'REJECTED');
  assert.equal(userUpdateSpy.mock.callCount(), 0);
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('reviewSensitiveChange (legacy IBAN request, approved): a completion-recompute failure is logged and does not undo the already-applied change', async (t) => {
  const { providerProfileService, userUpdateSpy, loggerErrorSpy } = await loadServiceForSensitiveFlow(t, { throwOnRecompute: true });

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
  });
  const reviewed = await providerProfileService.reviewSensitiveChange(request.id, true);

  assert.equal(reviewed.status, 'APPROVED');
  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  assert.equal(loggerErrorSpy.mock.callCount() > 0, true);
});

test('reviewSensitiveChange (legacy NATIONAL_ID request, approved): applies via the legacy path since no OTP-based category covers this field', async (t) => {
  const { providerProfileService, userUpdateSpy } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'NATIONAL_ID', fieldLabel: 'National ID', requestedValue: '1234567890'
  });
  const reviewed = await providerProfileService.reviewSensitiveChange(request.id, true);

  assert.equal(reviewed.status, 'APPROVED');
  const idCommit = userUpdateSpy.mock.calls.find((c: any) => 'idNumber' in c.arguments[0].data);
  assert.notEqual(idCommit, undefined);
  assert.equal(idCommit.arguments[0].data.idNumber, '1234567890');
});

test('reviewSensitiveChange: the legacy shape (category "PROFILE") and the modern OTP shape (CONTACT/BANKING/DOCUMENTS) both still resolve to the correct apply path independently', async (t) => {
  const { providerProfileService, userUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const legacyRequest = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: VALID_TEST_IBAN
  });
  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA5300000000000000000099'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);

  await providerProfileService.reviewSensitiveChange(legacyRequest.id, true);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  const ibanCommits = userUpdateSpy.mock.calls.filter((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.equal(ibanCommits.length, 2);
  assert.equal(ibanCommits[0].arguments[0].data.ibanNumber, VALID_TEST_IBAN);
  assert.equal(ibanCommits[1].arguments[0].data.ibanNumber, 'SA5300000000000000000099');
});

test('regression: no ClientProfile/AffiliateProfile writes from any sensitive-change path', async (t) => {
  const { providerProfileService, clientUpsertSpy, affiliateUpsertSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA5300000000000000000099'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.4 — getProfile()'s scattered self-heal, consolidated. A missing
// ProviderProfile row is now routed through the same canonical role-state
// initializer (account-management.service.ts#initializeRoleState) instead of
// a bare `{ userId }` create — seeding display fields, computing a real
// initial completion, and creating a ProviderGamification row, all inside
// one small transaction. Never resets anything if the row already exists.
// ============================================================================

function createGetProfileSelfHealMockPrisma(t: TestContext) {
  let providerProfileState: any = null;
  let gamificationState: any = null;
  const userFixture = {
    firstName: 'Amr', lastName: 'Okasha', avatarUrl: 'https://example.com/a.png', email: 'amr@example.com',
    phoneNumber: '0500000000', idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null,
    accountHolderName: null, idDocumentUrl: null
  };

  const providerCreateSpy = t.mock.fn((args: any) => {
    providerProfileState = { id: 'pp-1', skills: [], portfolioItems: [], educations: [], certificates: [], ...args.data };
    return providerProfileState;
  });
  const gamificationCreateSpy = t.mock.fn((args: any) => { gamificationState = { id: 'gam-1', ...args.data }; return gamificationState; });

  const tx = {
    providerProfile: { findUnique: async () => providerProfileState, create: providerCreateSpy },
    providerGamification: { findUnique: async () => gamificationState, create: gamificationCreateSpy }
  };

  const prismaMock = {
    providerProfile: {
      findUnique: async () => (providerProfileState ? { ...providerProfileState, user: userFixture } : null)
    },
    user: { findUnique: async () => userFixture },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });

  return { providerCreateSpy, gamificationCreateSpy, getProviderProfileState: () => providerProfileState };
}

async function loadServiceForGetProfileSelfHeal(t: TestContext) {
  const mocks = createGetProfileSelfHealMockPrisma(t);
  const moduleUrl = `./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerProfileService } = await import(moduleUrl);
  return { providerProfileService, ...mocks };
}

test('getProfile: a missing ProviderProfile is routed through the canonical initializer — seeds display, computes real completion, creates ProviderGamification', async (t) => {
  const { providerProfileService, providerCreateSpy, gamificationCreateSpy } = await loadServiceForGetProfileSelfHeal(t);

  const profile = await providerProfileService.getProfile('user-1');

  assert.equal(providerCreateSpy.mock.callCount(), 1);
  const data = providerCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(data.avatarUrl, 'https://example.com/a.png');
  assert.equal(typeof data.completionPercentage, 'number');

  assert.equal(gamificationCreateSpy.mock.callCount(), 1);
  assert.equal(profile.firstName, 'Amr');
});

// ============================================================================
// AI performance metrics via WaseetAI summarizePerformance (no network:
// the waseetAiClient module is mocked).
// ============================================================================

const VALID_AI_METRICS = {
  executionQuality: 88, onTimeDelivery: 90, communication: 85, clientSatisfaction: 92,
  onTimeCompletionRate: 87, repeatClientRate: 60, highRatingServicesRate: 75, conflictFreeDeliveryRate: 95
};
const DAY = 24 * 60 * 60 * 1000;
const signed = new Date('2025-01-01T00:00:00Z');
const stage = (days: number) => ({ status: 'APPROVED', approvedAt: new Date(signed.getTime() + days * DAY) });
const proj = (id: string, clientId: string, days: number | null, duration = 10) => ({
  id, clientId,
  contract: days === null ? null : { signedAt: signed, durationDays: duration, stages: [stage(days / 2), stage(days)] }
});

async function loadServiceForAiMetrics(t: TestContext, opts: {
  projects?: any[];
  reviewsCount?: number;
  fiveStar?: number;
  disputes?: any[];
  summarize?: (body: any) => Promise<any>;
  providerSpecialties?: any[];
} = {}) {
  const projects = opts.projects ?? [proj('p1', 'c1', 5)];
  const profileFixture: any = {
    userId: 'user-1', isVerified: false, location: null, city: 'Riyadh', rating: 5.0, headline: 'Senior Consultant',
    bio: 'bio', yearsOfExperience: 3, completionPercentage: 80, firstName: null, lastName: null, avatarUrl: null,
    githubUrl: null, linkedinUrl: null, websiteUrl: null, skills: [{ name: 'React' }], portfolioItems: [],
    providerSpecialties: opts.providerSpecialties ?? [],
    user: {
      firstName: 'Okasha', lastName: 'Expert', email: 'provider@example.com', avatarUrl: null,
      phoneNumber: '0500000000', createdAt: new Date('2024-01-01'), currentLevel: 'مستكشف - المستوى 1',
      ratingAverage: 4.8, profileCompletionPercent: 80
    }
  };
  const prismaMock: any = {
    providerProfile: { findUnique: async () => ({ ...profileFixture }) },
    project: { count: async () => projects.length, findMany: async () => projects },
    serviceCatalog: { findMany: async () => [] },
    review: {
      findMany: async () => [],
      count: async (args: any) => args?.where?.rating ? (opts.fiveStar ?? 0) : (opts.reviewsCount ?? 5)
    },
    dispute: { findMany: async () => opts.disputes ?? [] },
    providerGamification: { findUnique: async () => ({ avgRating: 4.8 }) }
  };
  const calls: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: {
    summarizePerformance: async (body: any) => { calls.push(body); return (opts.summarize ?? (async () => VALID_AI_METRICS))(body); }
  } } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: providerProfileService, calls };
}

test('getPublicProfile (aiMetrics): WaseetAI success maps all 8 fields and counts are derived from real data', async (t) => {
  const { service, calls } = await loadServiceForAiMetrics(t, {
    projects: [proj('p1', 'c1', 5), proj('p2', 'c1', 20), proj('p3', 'c2', 8)],
    reviewsCount: 4, fiveStar: 3, disputes: [{ projectId: 'p2' }, { projectId: 'p2' }]
  });
  const result = await service.getPublicProfile('user-1');
  assert.deepEqual(result.aiMetrics, { ...VALID_AI_METRICS, averageTestScore: 0, codeMatchingIndex: 0 });
  assert.deepEqual(calls, [{
    providerId: 'user-1', totalProjectsCompleted: 3, onTimeProjectsCount: 2, repeatClientsCount: 1,
    totalClientsCount: 2, fiveStarReviewsCount: 3, totalReviewsCount: 4, disputedProjectsCount: 1
  }]);
});

test('getPublicProfile (aiMetrics): upstream failure -> profile still returns, 8 metrics absent, DB-derived fields kept', async (t) => {
  const { service } = await loadServiceForAiMetrics(t, { summarize: async () => { throw new Error('upstream down'); } });
  const result = await service.getPublicProfile('user-1');
  assert.deepEqual(result.aiMetrics, { averageTestScore: 0, codeMatchingIndex: 0 });
  assert.equal(result.aiMetrics.executionQuality, undefined);
});

test('getPublicProfile (aiMetrics): malformed upstream payload is never surfaced', async (t) => {
  const { service } = await loadServiceForAiMetrics(t, { summarize: async () => ({ ...VALID_AI_METRICS, communication: 'x' }) });
  const result = await service.getPublicProfile('user-1');
  assert.equal(result.aiMetrics.communication, undefined);
});

test('getPublicProfile (aiMetrics): on-time timing not derivable -> no guessed count, no upstream call, metrics absent', async (t) => {
  const { service, calls } = await loadServiceForAiMetrics(t, { projects: [proj('p1', 'c1', 5), proj('p2', 'c2', null)] });
  const result = await service.getPublicProfile('user-1');
  assert.equal(calls.length, 0);
  assert.equal(result.aiMetrics.executionQuality, undefined);
});

test('getPublicProfile (aiMetrics): a stage that is not approved makes timing non-derivable', async (t) => {
  const p: any = proj('p1', 'c1', 5);
  p.contract.stages[1] = { status: 'SUBMITTED', approvedAt: null };
  const { service, calls } = await loadServiceForAiMetrics(t, { projects: [p] });
  await service.getPublicProfile('user-1');
  assert.equal(calls.length, 0);
});

test('getPublicProfile (aiMetrics): a late project is not counted on time (boundary: exactly on deadline is on time)', async (t) => {
  const { service, calls } = await loadServiceForAiMetrics(t, { projects: [proj('p1', 'c1', 10), proj('p2', 'c2', 10.5)] });
  await service.getPublicProfile('user-1');
  assert.equal(calls[0].onTimeProjectsCount, 1);
});

test('getPublicProfile (aiMetrics): successful results are cached per exact counts; failures are not cached', async (t) => {
  const { service, calls } = await loadServiceForAiMetrics(t);
  await service.getPublicProfile('user-1');
  await service.getPublicProfile('user-1');
  assert.equal(calls.length, 1);
});

test('getPublicProfile (aiMetrics): a failed upstream call is not cached', async (t) => {
  let n = 0;
  const f = await loadServiceForAiMetrics(t, { summarize: async () => { if (n++ === 0) throw new Error('x'); return VALID_AI_METRICS; } });
  const first = await f.service.getPublicProfile('user-1');
  const second = await f.service.getPublicProfile('user-1');
  assert.equal(first.aiMetrics.executionQuality, undefined);
  assert.equal(second.aiMetrics.executionQuality, 88);
});

test('getPublicProfile (aiMetrics): zero projects AND zero reviews short-circuits to honest zeros without calling WaseetAI', async (t) => {
  const { service, calls } = await loadServiceForAiMetrics(t, { projects: [], reviewsCount: 0 });
  const result = await service.getPublicProfile('user-1');
  assert.equal(calls.length, 0);
  assert.deepEqual(result.aiMetrics, { ...ZERO_AI_METRICS_FOR_TEST, averageTestScore: 0, codeMatchingIndex: 0 });
});

const ZERO_AI_METRICS_FOR_TEST = {
  executionQuality: 0, onTimeDelivery: 0, communication: 0, clientSatisfaction: 0,
  onTimeCompletionRate: 0, repeatClientRate: 0, highRatingServicesRate: 0, conflictFreeDeliveryRate: 0
};

test('getPublicProfile (aiMetrics): averageTestScore/codeMatchingIndex stay DB arithmetic; request carries no PII', async (t) => {
  const specialty = {
    id: 'spec-1', subSpecialties: [], latestScore: 90, quizScore: null, isPassed: true, aiScore: null,
    specialty: { nameAr: 'تطوير الويب', name: 'Web', iconName: 'code' },
    status: 'APPROVED', hasTakenAssessment: true, passedAt: new Date(),
    assessmentAttempts: [],
    accreditationSamples: [{ id: 'sample-1', title: 'Sample', description: '', technologiesUsed: [], attachments: [], aiScore: 80, aiQualityRating: 'GOOD', aiFeedbackAr: '' }]
  };
  const { service, calls } = await loadServiceForAiMetrics(t, { providerSpecialties: [specialty] });
  const result = await service.getPublicProfile('user-1');
  assert.equal(result.aiMetrics.averageTestScore, 90);
  assert.equal(result.aiMetrics.codeMatchingIndex, 80);
  const sent = JSON.stringify(calls[0]);
  assert.ok(!sent.includes('provider@example.com') && !sent.includes('0500000000'));
});

test('static: touched provider-profile sources contain no direct Gemini usage', () => {
  const dir = path.resolve(__dirname, '..');
  const files = ['services/provider-profile.service.ts', 'controllers/provider-profile.controller.ts', 'routes/provider-profile.routes.ts'];
  for (const f of files) assert.doesNotMatch(readFileSync(path.join(dir, f), 'utf8'), /gemini\.client|geminiClient|generateStructured|generateStream/, f);
});

// ── BE-1: getPublicProfile wiring (source contract; the pure logic is unit-tested in provider-public-profile.helpers.test.ts) ──

test('getPublicProfile: assessment card from the real attempt only, services carry specialtyName, company summary is count-only', () => {
  const src = readFileSync(path.join(__dirname, 'provider-profile.service.ts'), 'utf8');
  const method = src.slice(src.indexOf('async getPublicProfile'));
  const pub = method.slice(0, method.indexOf('\n\t/**') > 0 ? method.indexOf('\n\t/**') : undefined);
  assert.ok(pub.includes('buildAssessmentDetails(latestAttempt, ps)'));
  assert.ok(!/totalQuestions:\s*latestAttempt\.totalQuestions\s*\|\|\s*20/.test(pub));
  assert.ok(!/timeLimitMinutes\s*\|\|\s*12/.test(pub));
  assert.ok(pub.includes('services: publishedServices.map(withSpecialtyName)'));
  assert.ok(pub.includes("include: { specialty: { select: { nameAr: true, name: true } } }"));
  assert.ok(pub.includes("companyTeamMember.count({ where: { companyOwnerId: providerId, status: 'ACTIVE' } })"));
  assert.ok(pub.includes('buildCompanySummary('));
  // nothing personal / documentary about the company leaves through the public endpoint
  assert.ok(!/commercialRegistration|vatCertificateUrl|idDocumentUrl/.test(pub));
  assert.ok(!/companyTeamMember\.findMany/.test(pub));
});
