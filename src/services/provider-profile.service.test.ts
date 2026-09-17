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
    ibanNumber: 'SA0000000000000000000011',
    idDocumentUrl: 'https://cdn.example/id.pdf'
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
      findFirst: async (args: any) =>
        Object.values(otpsById).find((o: any) => o.userId === args.where.userId && o.code === args.where.code && o.type === args.where.type) || null,
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

test('initiateSensitiveChange (BANKING): does not recalculate completion at initiation time', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy } = await loadServiceForSensitiveFlow(t);

  await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA0000000000000000000011'
  });

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('verifySensitiveChange (BANKING, pending human review): does not recalculate before admin approval', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA0000000000000000000011'
  });
  const verified = await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);

  assert.equal(verified.status, 'PENDING_HUMAN_REVIEW');
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('reviewSensitiveChange (BANKING, approved): recalculates completion after ibanNumber actually commits', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, callOrder, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA0000000000000000000011'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  assert.equal(ibanCommit.arguments[0].data.ibanNumber, 'SA0000000000000000000011');

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
    idDocumentUrl: 'https://cdn.example/id.pdf'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  const docCommit = userUpdateSpy.mock.calls.find((c: any) => 'idDocumentUrl' in c.arguments[0].data);
  assert.notEqual(docCommit, undefined);

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
});

test('verifySensitiveChange (CONTACT, applied immediately since it needs no review): does NOT trigger provider completion recalculation', async (t) => {
  const { providerProfileService, providerProfileUpdateSpy, userUpdateSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'CONTACT', {
    email: 'new@example.com', phoneNumber: '0511111111', alternativePhone: '0522222222'
  });
  const verified = await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);

  assert.equal(verified.status, 'APPROVED');
  const emailCommit = userUpdateSpy.mock.calls.find((c: any) => 'email' in c.arguments[0].data);
  assert.notEqual(emailCommit, undefined);

  // Approved 3D.2B scope decision: CONTACT never triggers this recompute,
  // even though email/phoneNumber are themselves formula inputs elsewhere —
  // only the BANKING/ibanNumber and DOCUMENTS/idDocumentUrl commit points do.
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('reviewSensitiveChange (BANKING, approved): a completion-recompute failure is logged and does not fail the already-successful sensitive change', async (t) => {
  const { providerProfileService, userUpdateSpy, loggerErrorSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t, { throwOnRecompute: true });

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA0000000000000000000011'
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
  assert.doesNotMatch(String(loggedError[0]), /SA0000000000000000000011/);
});

test('createModificationRequest (IBAN, approved): commits User.ibanNumber first, then recalculates provider completion', async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0.9; // 85 + 9 = 94 > 92 -> APPROVED
  t.after(() => { Math.random = originalRandom; });

  const { providerProfileService, userUpdateSpy, providerProfileUpdateSpy, callOrder } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: 'SA0000000000000000000099'
  });

  assert.equal(request.status, 'APPROVED');
  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  assert.equal(ibanCommit.arguments[0].data.ibanNumber, 'SA0000000000000000000099');

  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 1);
  assert.equal(callOrder.indexOf('user.update') < callOrder.indexOf('providerProfile.update:completion'), true);
});

test('createModificationRequest (IBAN, not approved): does not commit or recalculate', async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0; // 85 <= 92 -> PENDING_HUMAN_REVIEW
  t.after(() => { Math.random = originalRandom; });

  const { providerProfileService, userUpdateSpy, providerProfileUpdateSpy } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: 'SA0000000000000000000099'
  });

  assert.equal(request.status, 'PENDING_HUMAN_REVIEW');
  assert.equal(userUpdateSpy.mock.callCount(), 0);
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('createModificationRequest (EMAIL, approved): commits email but does not trigger provider completion recalculation', async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0.9;
  t.after(() => { Math.random = originalRandom; });

  const { providerProfileService, userUpdateSpy, providerProfileUpdateSpy } = await loadServiceForSensitiveFlow(t);

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'EMAIL', fieldLabel: 'Email', requestedValue: 'new@example.com'
  });

  assert.equal(request.status, 'APPROVED');
  const emailCommit = userUpdateSpy.mock.calls.find((c: any) => 'email' in c.arguments[0].data);
  assert.notEqual(emailCommit, undefined);
  const completionCalls = providerProfileUpdateSpy.mock.calls.filter((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.equal(completionCalls.length, 0);
});

test('createModificationRequest (IBAN, approved): a completion-recompute failure is logged and does not undo the approved IBAN change', async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0.9;
  t.after(() => { Math.random = originalRandom; });

  const { providerProfileService, userUpdateSpy, loggerErrorSpy } = await loadServiceForSensitiveFlow(t, { throwOnRecompute: true });

  const request = await providerProfileService.createModificationRequest('user-1', {
    fieldName: 'IBAN', fieldLabel: 'IBAN', requestedValue: 'SA0000000000000000000099'
  });

  assert.equal(request.status, 'APPROVED');
  const ibanCommit = userUpdateSpy.mock.calls.find((c: any) => 'ibanNumber' in c.arguments[0].data);
  assert.notEqual(ibanCommit, undefined);
  assert.equal(loggerErrorSpy.mock.callCount() > 0, true);
});

test('regression: no ClientProfile/AffiliateProfile writes from any sensitive-change path', async (t) => {
  const { providerProfileService, clientUpsertSpy, affiliateUpsertSpy, getLastOtpCode } = await loadServiceForSensitiveFlow(t);

  const initiated = await providerProfileService.initiateSensitiveChange('user-1', 'BANKING', {
    accountHolderName: 'Amr Okasha', bankName: 'Al Rajhi', ibanNumber: 'SA0000000000000000000011'
  });
  await providerProfileService.verifySensitiveChange('user-1', initiated.requestId, getLastOtpCode()!);
  await providerProfileService.reviewSensitiveChange(initiated.requestId, true);

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
});
