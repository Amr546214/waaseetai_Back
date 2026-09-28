import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { UserRole } from '@prisma/client';
import { deriveProviderProgression } from '../utils/progression-calculators';

// Phase 3D.4: initializeRoleState/createMissingRoleProfiles take their
// Prisma(-transaction) client as a parameter — no module-level `prisma` is
// touched by either function directly — but account-management.service.ts
// also imports account-logs.service.ts, which DOES capture the real,
// unmocked `prisma` from '../config/db' at ITS OWN module-load time if ever
// loaded without a mock in place first. A static top-level import here would
// permanently cache that real reference and break the switchActiveRole test
// below (which relies on a fresh, mocked reimport) — so every load of
// account-management.service.ts in this file, even for these
// mock-independent pure-ish functions, goes through the same
// mock.module('../config/db', ...) + cache-busted dynamic import pattern.
async function loadCanonicalInitializer(t: TestContext) {
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  const moduleUrl = `./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { initializeRoleState, createMissingRoleProfiles } = await import(moduleUrl);
  return { initializeRoleState, createMissingRoleProfiles };
}

// Phase 3C, problem #5: switching activeRole must return a user shape whose
// display/progression fields already represent the NEW role, not the one
// just left. Runs against a fully mocked prisma client (mock.module
// intercepts '../config/db' before the service is imported, so the real
// db.ts — which opens a pg Pool — never executes; no database is touched).

process.env.JWT_SECRET = 'test-secret';

const legacyUser = {
  id: 'user-1',
  accountType: 'CLIENT_INDIVIDUAL',
  roles: ['CLIENT', 'PROVIDER'],
  activeRole: 'CLIENT',
  firstName: 'Legacy',
  lastName: 'Name',
  email: 'user@example.com',
  avatarUrl: 'https://legacy.example/avatar.png',
  profileCompletionPercent: 42,
  currentLevel: 'مستكشف - المستوى 1',
  currentPoints: 5,
  pointsToNextLevel: 95
};

async function loadServiceWithFixture(t: TestContext) {
  const updateSpy = t.mock.fn((args: any) => ({ ...legacyUser, ...args.data }));
  t.mock.module('../config/db', {
    // Node's node:test mock.module() option for supplying named exports is
    // `namedExports` (see the Node.js test runner "Mocking modules" docs) —
    // `exports` is not a recognized key. On Node 22.23.2 an unrecognized key
    // is silently ignored, so the mocked '../config/db' ended up with zero
    // named exports and `prisma` resolved to undefined, throwing
    // "Cannot read properties of undefined (reading 'user')" the moment the
    // service touched prisma.user. (Node 26's mock.module happens to also
    // accept `exports`, which is why this only failed on Node 22.)
    namedExports: {
      prisma: {
        user: {
          findUnique: async (args: any) => {
            if (args?.select?.providerProfile) {
              return {
                providerProfile: {
                  firstName: 'Provider',
                  lastName: 'Persona',
                  avatarUrl: 'https://provider.example/avatar.png',
                  completionPercentage: 80
                },
                gamification: { points: 50, currentLevelIndex: 2 }
              };
            }
            return legacyUser;
          },
          update: updateSpy
        },
        accountAuditLog: {
          create: async () => ({})
        }
      }
    }
  });
  const moduleUrl = `./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accountManagementService } = await import(moduleUrl);
  return { accountManagementService };
}

test('switchActiveRole CLIENT -> PROVIDER returns the NEW role\'s display/progression fields, not the legacy/CLIENT ones', async (t) => {
  const { accountManagementService } = await loadServiceWithFixture(t);

  const result = await accountManagementService.switchActiveRole('user-1', 'PROVIDER');

  assert.equal(result.user.activeRole, 'PROVIDER');
  assert.equal(result.user.firstName, 'Provider');
  assert.equal(result.user.lastName, 'Persona');
  assert.equal(result.user.avatarUrl, 'https://provider.example/avatar.png');
  assert.equal(result.user.profileCompletionPercent, 80);
  // Provider progression must come from ProviderGamification/LEVEL_MATRIX,
  // never from the legacy User columns.
  assert.equal(result.user.currentLevel, 'منجز');
  assert.equal(result.user.currentPoints, 50);
  assert.notEqual(result.user.firstName, legacyUser.firstName);
});

// ============================================================================
// Phase 3D.4 — initializeRoleState / createMissingRoleProfiles: the canonical
// role-state initializer. On first creation only, seeds display fields from
// the shared User identity, computes a REAL initial completion via the exact
// existing Phase 3D.2 pure calculators (no new formula), and for PROVIDER
// ensures a correct zero-state ProviderGamification row via the exact
// existing Phase 3D.3A pure calculator (no PointTransaction). Idempotent:
// never resets existing independent display/completion/progression data.
// ============================================================================

const identity = {
  firstName: 'Amr',
  lastName: 'Okasha',
  avatarUrl: 'https://example.com/a.png',
  email: 'amr@example.com',
  phoneNumber: '0500000000',
  idNumber: null,
  idExpiryDate: null,
  ibanNumber: null,
  bankName: null,
  accountHolderName: null,
  idDocumentUrl: null
};

function createFakeTx(t: TestContext, seed: {
  clientProfile?: any;
  providerProfile?: any;
  providerGamification?: any;
  affiliateProfile?: any;
} = {}) {
  let clientProfile = seed.clientProfile ?? null;
  let providerProfile = seed.providerProfile ?? null;
  let providerGamification = seed.providerGamification ?? null;
  let affiliateProfile = seed.affiliateProfile ?? null;

  const clientCreateSpy = t.mock.fn((args: any) => { clientProfile = { id: 'client-1', ...args.data }; return clientProfile; });
  const providerCreateSpy = t.mock.fn((args: any) => { providerProfile = { id: 'provider-1', ...args.data }; return providerProfile; });
  const gamificationCreateSpy = t.mock.fn((args: any) => { providerGamification = { id: 'gam-1', ...args.data }; return providerGamification; });
  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateProfile = { id: 'affiliate-1', ...args.data }; return affiliateProfile; });

  const tx: any = {
    clientProfile: { findUnique: async () => clientProfile, create: clientCreateSpy },
    providerProfile: { findUnique: async () => providerProfile, create: providerCreateSpy },
    providerGamification: { findUnique: async () => providerGamification, create: gamificationCreateSpy },
    affiliateProfile: { findUnique: async () => affiliateProfile, create: affiliateCreateSpy }
  };

  return {
    tx, clientCreateSpy, providerCreateSpy, gamificationCreateSpy, affiliateCreateSpy,
    getClientProfile: () => clientProfile, getProviderProfile: () => providerProfile,
    getProviderGamification: () => providerGamification, getAffiliateProfile: () => affiliateProfile
  };
}

// --- CLIENT -----------------------------------------------------------------

test('initializeRoleState (CLIENT): first creation seeds firstName/lastName/avatarUrl from the shared User identity', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, clientCreateSpy } = createFakeTx(t);
  const created = await initializeRoleState(tx, 'user-1', UserRole.CLIENT, identity);

  assert.equal(created, true);
  assert.equal(clientCreateSpy.mock.callCount(), 1);
  const data = clientCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(data.avatarUrl, 'https://example.com/a.png');
});

test('initializeRoleState (CLIENT): computes real initial completion from the seeded state via the exact existing computeClientCompletion', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, clientCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.CLIENT, identity);

  // firstName + lastName + avatarUrl + phoneNumber = 4 * 7.5 = 30 (base fields only).
  assert.equal(clientCreateSpy.mock.calls[0].arguments[0].data.completionPercentage, 30);
});

test('initializeRoleState (CLIENT): does not introduce a Client points system — no currentLevel/currentPoints/pointsToNextLevel written, schema defaults remain the source', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, clientCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.CLIENT, identity);

  const data = clientCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal('currentLevel' in data, false);
  assert.equal('currentPoints' in data, false);
  assert.equal('pointsToNextLevel' in data, false);
});

test('initializeRoleState (CLIENT): repeat call for an existing profile is a total no-op — independent display is never overwritten', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, clientCreateSpy } = createFakeTx(t, {
    clientProfile: { id: 'client-1', firstName: 'Independent', lastName: 'Value', completionPercentage: 77 }
  });
  const created = await initializeRoleState(tx, 'user-1', UserRole.CLIENT, identity);

  assert.equal(created, false);
  assert.equal(clientCreateSpy.mock.callCount(), 0);
});

test('initializeRoleState (CLIENT): repeat call does not reset an existing independent completion score', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, getClientProfile } = createFakeTx(t, {
    clientProfile: { id: 'client-1', completionPercentage: 77 }
  });
  await initializeRoleState(tx, 'user-1', UserRole.CLIENT, identity);

  assert.equal(getClientProfile().completionPercentage, 77);
});

// --- PROVIDER -----------------------------------------------------------------

test('initializeRoleState (PROVIDER): first creation seeds display and computes real initial completion via the exact existing computeProviderCompletion', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, providerCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.PROVIDER, identity);

  const data = providerCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(data.avatarUrl, 'https://example.com/a.png');
  // avatarUrl(10) + email&&phoneNumber(10) = 20. The name+headline+
  // mainSpecialty combo factor does NOT trigger — no headline/mainSpecialty
  // exist on User to seed, matching the existing formula's real behavior
  // (not an invented score).
  assert.equal(data.completionPercentage, 20);
});

test('initializeRoleState (PROVIDER): ProviderGamification row is created immediately, with zero-state values matching deriveProviderProgression(0,0,0)', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, gamificationCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.PROVIDER, identity);

  assert.equal(gamificationCreateSpy.mock.callCount(), 1);
  const data = gamificationCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.points, 0);
  assert.equal(data.completedProjects, 0);
  assert.equal(data.avgRating, 0);

  const expected = deriveProviderProgression({ points: 0, completedProjects: 0, avgRating: 0 });
  assert.equal(data.currentLevelIndex, expected.currentLevelIndex);
  assert.equal(data.currentCommission, expected.currentCommission);
  assert.equal(data.currentLevelIndex, 1);
  assert.equal(data.currentCommission, 5.0);
});

test('initializeRoleState (PROVIDER): never creates a PointTransaction for initialization', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx } = createFakeTx(t);
  // The fake tx has no `pointTransaction` model at all — if
  // initializeRoleState ever touched it, this would throw
  // "Cannot read properties of undefined".
  await initializeRoleState(tx, 'user-1', UserRole.PROVIDER, identity);
});

test('initializeRoleState (PROVIDER): existing ProviderProfile + missing ProviderGamification repairs ONLY the missing gamification row', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, providerCreateSpy, gamificationCreateSpy } = createFakeTx(t, {
    providerProfile: { id: 'provider-1', firstName: 'Independent', completionPercentage: 55 }
  });
  const created = await initializeRoleState(tx, 'user-1', UserRole.PROVIDER, identity);

  assert.equal(created, true); // gamification was created
  assert.equal(providerCreateSpy.mock.callCount(), 0); // existing profile untouched
  assert.equal(gamificationCreateSpy.mock.callCount(), 1);
});

test('initializeRoleState (PROVIDER): an existing ProviderGamification row is never reset', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, gamificationCreateSpy, getProviderGamification } = createFakeTx(t, {
    providerProfile: { id: 'provider-1' },
    providerGamification: { id: 'gam-1', points: 500, completedProjects: 10, avgRating: 4.5, currentLevelIndex: 6, currentCommission: 14.0 }
  });
  const created = await initializeRoleState(tx, 'user-1', UserRole.PROVIDER, identity);

  assert.equal(created, false);
  assert.equal(gamificationCreateSpy.mock.callCount(), 0);
  assert.equal(getProviderGamification().points, 500);
  assert.equal(getProviderGamification().currentLevelIndex, 6);
});

test('initializeRoleState (PROVIDER): repeat call for a fully-existing provider is a total no-op — display/completion never overwritten', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, providerCreateSpy, gamificationCreateSpy } = createFakeTx(t, {
    providerProfile: { id: 'provider-1', completionPercentage: 40 },
    providerGamification: { id: 'gam-1', points: 100, currentLevelIndex: 1, currentCommission: 15.0 }
  });
  await initializeRoleState(tx, 'user-1', UserRole.PROVIDER, identity);

  assert.equal(providerCreateSpy.mock.callCount(), 0);
  assert.equal(gamificationCreateSpy.mock.callCount(), 0);
});

// --- AFFILIATE -----------------------------------------------------------------

test('initializeRoleState (AFFILIATE): first creation seeds display, generates a referralSlug with the existing semantics, and computes real completion via the extracted computeAffiliateCompletion', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, affiliateCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.AFFILIATE, identity);

  assert.equal(affiliateCreateSpy.mock.callCount(), 1);
  const data = affiliateCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(data.avatarUrl, 'https://example.com/a.png');
  assert.equal(typeof data.referralSlug, 'string');
  assert.equal(data.referralSlug.length > 0, true);
  // avatar(15) + basic identity firstName+lastName+email(30) = 45; zero
  // marketing channels, no bio, no IBAN at creation.
  assert.equal(data.completionPercentage, 45);
});

test('initializeRoleState (AFFILIATE): does not touch currentLevel — preserves the existing schema default, introduces no affiliate points system', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, affiliateCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.AFFILIATE, identity);

  const data = affiliateCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal('currentLevel' in data, false);
  assert.equal('points' in data, false);
  assert.equal('currentPoints' in data, false);
});

test('initializeRoleState (AFFILIATE): repeat call does not overwrite existing display/currentLevel/completion', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, affiliateCreateSpy } = createFakeTx(t, {
    affiliateProfile: { id: 'affiliate-1', firstName: 'Independent', currentLevel: 'موصل', completionPercentage: 90 }
  });
  const created = await initializeRoleState(tx, 'user-1', UserRole.AFFILIATE, identity);

  assert.equal(created, false);
  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.5A — Affiliate progression regression tests.
//
// Phase 3D.5's audit concluded Affiliate progression ("مساعد"/"موصل") is
// scaffolded but not implemented anywhere in the codebase — no writer for
// AffiliateProfile.currentLevel exists at all, before or after Phase 3D.4.
// BUSINESS DECISION: do not implement automatic promotion, do not invent a
// threshold. These tests exist only to lock in the CURRENT behavior so a
// future change cannot silently start writing/overwriting currentLevel.
//
// The fake `tx.affiliateProfile` below deliberately has no `update` method
// at all (only `findUnique`/`create`) — if initializeRoleState ever tried to
// call `.update()` on an existing row, these tests would fail with a
// TypeError, which is itself proof no update path is exercised.
// ============================================================================

test('initializeRoleState (AFFILIATE): first creation does NOT explicitly set currentLevel — the schema default remains solely responsible for the initial "مساعد" value', async (t) => {
  const { initializeRoleState } = await loadCanonicalInitializer(t);
  const { tx, affiliateCreateSpy } = createFakeTx(t);
  await initializeRoleState(tx, 'user-1', UserRole.AFFILIATE, identity);

  assert.equal(affiliateCreateSpy.mock.callCount(), 1);
  const data = affiliateCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal('currentLevel' in data, false);
});

test('initializeRoleState (AFFILIATE): re-running for an existing profile at the default "مساعد" level never updates or overwrites currentLevel', async (t) => {
  const { initializeRoleState } = await loadCanonicalInitializer(t);
  const { tx, affiliateCreateSpy, getAffiliateProfile } = createFakeTx(t, {
    affiliateProfile: { id: 'affiliate-1', currentLevel: 'مساعد', completionPercentage: 45 }
  });

  const created = await initializeRoleState(tx, 'user-1', UserRole.AFFILIATE, identity);

  assert.equal(created, false);
  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
  assert.equal(getAffiliateProfile().currentLevel, 'مساعد');
});

test('initializeRoleState (AFFILIATE): an existing currentLevel="موصل" remains untouched by repeated initialization', async (t) => {
  const { initializeRoleState } = await loadCanonicalInitializer(t);
  const { tx, affiliateCreateSpy, getAffiliateProfile } = createFakeTx(t, {
    affiliateProfile: { id: 'affiliate-1', currentLevel: 'موصل', completionPercentage: 90 }
  });

  const created = await initializeRoleState(tx, 'user-1', UserRole.AFFILIATE, identity);

  assert.equal(created, false);
  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
  assert.equal(getAffiliateProfile().currentLevel, 'موصل');
});

// --- createMissingRoleProfiles (thin per-role loop) ---------------------------

test('createMissingRoleProfiles: creates all three role rows + ProviderGamification for a user missing all of them', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, clientCreateSpy, providerCreateSpy, gamificationCreateSpy, affiliateCreateSpy } = createFakeTx(t);

  const result = await createMissingRoleProfiles(tx, 'user-1', [UserRole.CLIENT, UserRole.PROVIDER, UserRole.AFFILIATE], identity);

  assert.equal(result.clientCreated, true);
  assert.equal(result.providerCreated, true);
  assert.equal(result.affiliateCreated, true);
  assert.equal(clientCreateSpy.mock.callCount(), 1);
  assert.equal(providerCreateSpy.mock.callCount(), 1);
  assert.equal(gamificationCreateSpy.mock.callCount(), 1);
  assert.equal(affiliateCreateSpy.mock.callCount(), 1);
});

test('createMissingRoleProfiles: is a total no-op for roles that already have their profile row (+ gamification)', async (t) => {
  const { initializeRoleState, createMissingRoleProfiles } = await loadCanonicalInitializer(t);
  const { tx, clientCreateSpy, providerCreateSpy, gamificationCreateSpy } = createFakeTx(t, {
    clientProfile: { id: 'client-1' },
    providerProfile: { id: 'provider-1' },
    providerGamification: { id: 'gam-1' }
  });

  const result = await createMissingRoleProfiles(tx, 'user-1', [UserRole.CLIENT, UserRole.PROVIDER], identity);

  assert.equal(result.clientCreated, false);
  assert.equal(result.providerCreated, false);
  assert.equal(clientCreateSpy.mock.callCount(), 0);
  assert.equal(providerCreateSpy.mock.callCount(), 0);
  assert.equal(gamificationCreateSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.4 — addAccountType(): the newly-added role now receives the same
// initialization guarantees as createMissingRoleProfiles, via the same
// canonical initializer, without duplicating any formula. Existing role
// validation, updatedRoles semantics, activeRole=targetRole behavior, JWT and
// audit-log behavior are unchanged — only initialization got richer.
// ============================================================================

function createAddAccountTypeMockPrisma(t: TestContext, opts: {
  existingRoles?: string[];
  accountType?: string;
  throwOnProviderCreate?: boolean;
} = {}) {
  const userFixture: any = {
    id: 'user-1',
    accountType: opts.accountType || 'CLIENT_INDIVIDUAL',
    roles: opts.existingRoles || ['CLIENT'],
    firstName: 'Amr',
    lastName: 'Okasha',
    avatarUrl: 'https://example.com/a.png',
    email: 'amr@example.com',
    phoneNumber: '0500000000',
    idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null, accountHolderName: null, idDocumentUrl: null,
    clientProfile: null, providerProfile: null, affiliateProfile: null
  };

  let clientProfile: any = null;
  let providerProfile: any = null;
  let providerGamification: any = null;
  let affiliateProfile: any = null;

  const clientCreateSpy = t.mock.fn((args: any) => { clientProfile = { id: 'client-1', ...args.data }; return clientProfile; });
  const providerCreateSpy = t.mock.fn((args: any) => {
    if (opts.throwOnProviderCreate) throw new Error('simulated DB failure creating ProviderProfile');
    providerProfile = { id: 'provider-1', ...args.data };
    return providerProfile;
  });
  const gamificationCreateSpy = t.mock.fn((args: any) => { providerGamification = { id: 'gam-1', ...args.data }; return providerGamification; });
  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateProfile = { id: 'affiliate-1', ...args.data }; return affiliateProfile; });
  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));
  const auditLogCreateSpy = t.mock.fn(async () => ({}));

  const tx = {
    clientProfile: { findUnique: async () => clientProfile, create: clientCreateSpy },
    providerProfile: { findUnique: async () => providerProfile, create: providerCreateSpy },
    providerGamification: { findUnique: async () => providerGamification, create: gamificationCreateSpy },
    affiliateProfile: { findUnique: async () => affiliateProfile, create: affiliateCreateSpy },
    user: { update: userUpdateSpy },
    accountAuditLog: { create: auditLogCreateSpy }
  };

  const prismaMock = {
    user: { findUnique: async () => ({ ...userFixture }) },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return {
    clientCreateSpy, providerCreateSpy, gamificationCreateSpy, affiliateCreateSpy, userUpdateSpy, auditLogCreateSpy
  };
}

async function loadServiceForAddAccountType(t: TestContext, opts?: Parameters<typeof createAddAccountTypeMockPrisma>[1]) {
  const mocks = createAddAccountTypeMockPrisma(t, opts);
  const moduleUrl = `./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accountManagementService } = await import(moduleUrl);
  return { accountManagementService, ...mocks };
}

test('addAccountType: CLIENT initialization seeds display + real completion via the canonical initializer', async (t) => {
  const { accountManagementService, clientCreateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['PROVIDER'], accountType: 'PROVIDER_INDIVIDUAL' });

  await accountManagementService.addAccountType('user-1', 'CLIENT', { coName: 'Acme', coCrn: '12345', portfolioBio: 'bio text' });

  assert.equal(clientCreateSpy.mock.callCount(), 1);
  const data = clientCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.companyName, 'Acme');
  assert.equal(data.crNumber, '12345');
  assert.equal(data.bio, 'bio text');
  assert.equal(typeof data.completionPercentage, 'number');
});

test('addAccountType: PROVIDER initialization creates the profile AND its ProviderGamification row together', async (t) => {
  const { accountManagementService, providerCreateSpy, gamificationCreateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  await accountManagementService.addAccountType('user-1', 'PROVIDER', { specMain: 'دعم فني', portfolioBio: 'bio', specExp: '3' });

  assert.equal(providerCreateSpy.mock.callCount(), 1);
  assert.equal(gamificationCreateSpy.mock.callCount(), 1);
  const data = providerCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.headline, 'دعم فني');
  assert.equal(data.yearsOfExperience, 3);
  const gamData = gamificationCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(gamData.currentLevelIndex, 1);
  assert.equal(gamData.currentCommission, 5.0);
});

test('addAccountType: AFFILIATE initialization seeds display + completion and generates a referralSlug', async (t) => {
  const { accountManagementService, affiliateCreateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  await accountManagementService.addAccountType('user-1', 'AFFILIATE');

  assert.equal(affiliateCreateSpy.mock.callCount(), 1);
  const data = affiliateCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(typeof data.referralSlug, 'string');
});

test('addAccountType: richer Provider metadata (a long bio) contributes to the initial completion score via the exact existing formula', async (t) => {
  const { accountManagementService, providerCreateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  await accountManagementService.addAccountType('user-1', 'PROVIDER', { portfolioBio: 'x'.repeat(60) });

  const data = providerCreateSpy.mock.calls[0].arguments[0].data;
  // avatarUrl(10) + bio>=50 chars(15) + email&&phoneNumber(10) = 35. The
  // name+headline+mainSpecialty combo factor does NOT trigger here —
  // addAccountType's DTO has no field mapped to `mainSpecialty` at all (only
  // `specMain` -> `headline`), an existing, unrelated quirk this phase
  // preserves exactly, not introduces.
  assert.equal(data.completionPercentage, 35);
});

test('addAccountType: activeRole becomes the newly added targetRole (existing behavior, unchanged)', async (t) => {
  const { accountManagementService, userUpdateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  const result = await accountManagementService.addAccountType('user-1', 'PROVIDER');

  assert.equal(result.user.activeRole, 'PROVIDER');
  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.activeRole, 'PROVIDER');
});

test('addAccountType: audit log created and token/response contract unchanged', async (t) => {
  const { accountManagementService, auditLogCreateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  const result = await accountManagementService.addAccountType('user-1', 'PROVIDER');

  assert.equal(auditLogCreateSpy.mock.callCount(), 1);
  assert.equal(typeof result.token, 'string');
  assert.equal(result.user.id, 'user-1');
  assert.equal(result.user.roles.includes('PROVIDER'), true);
});

test('addAccountType: a role-initialization failure prevents User.roles from being updated in the same attempt (real DB transaction would roll both back)', async (t) => {
  const { accountManagementService, userUpdateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL', throwOnProviderCreate: true });

  await assert.rejects(() => accountManagementService.addAccountType('user-1', 'PROVIDER'));
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

// ============================================================================
// P0-1 remediation — addAccountType() service-level allowlist (defense in
// depth layer 2, behind the Zod SelfServiceUserRoleEnum at the DTO layer).
// A CLIENT/PROVIDER/AFFILIATE caller must never be able to self-escalate to
// ADMIN/SUPER_ADMIN by calling addAccountType directly with a privileged
// targetRole, regardless of what already validated the request body upstream.
// ============================================================================

test('addAccountType: a CLIENT caller cannot add ADMIN — rejected before any write', async (t) => {
  const { accountManagementService, userUpdateSpy, auditLogCreateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  await assert.rejects(() => accountManagementService.addAccountType('user-1', 'ADMIN' as any), /الدور المطلوب غير متاح للإضافة الذاتية/);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
  assert.equal(auditLogCreateSpy.mock.callCount(), 0);
});

test('addAccountType: a CLIENT caller cannot add SUPER_ADMIN — rejected before any write', async (t) => {
  const { accountManagementService, userUpdateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  await assert.rejects(() => accountManagementService.addAccountType('user-1', 'SUPER_ADMIN' as any));
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('addAccountType: a PROVIDER caller cannot add ADMIN — rejected before any write', async (t) => {
  const { accountManagementService, userUpdateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['PROVIDER'], accountType: 'PROVIDER_INDIVIDUAL' });

  await assert.rejects(() => accountManagementService.addAccountType('user-1', 'ADMIN' as any));
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('addAccountType: an AFFILIATE caller cannot add SUPER_ADMIN — rejected before any write', async (t) => {
  const { accountManagementService, userUpdateSpy } = await loadServiceForAddAccountType(t, { existingRoles: ['AFFILIATE'], accountType: 'MARKETING_BROKER' });

  await assert.rejects(() => accountManagementService.addAccountType('user-1', 'SUPER_ADMIN' as any));
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('addAccountType: legitimate self-service roles (CLIENT/PROVIDER/AFFILIATE) are unaffected by the new allowlist check', async (t) => {
  const { accountManagementService } = await loadServiceForAddAccountType(t, { existingRoles: ['CLIENT'], accountType: 'CLIENT_INDIVIDUAL' });

  const result = await accountManagementService.addAccountType('user-1', 'AFFILIATE');
  assert.equal(result.user.roles.includes('AFFILIATE'), true);
});

// ============================================================================
// Phase 3D.4 — getAvailableAccountTypes() atomicity fix. Previously,
// User.roles repair and profile-row repair were two separate, non-
// transactional statements — a crash between them could leave User.roles
// claiming a role with no matching profile row. Now atomic together, and
// skipped entirely (no transaction opened) when nothing needs repairing.
// ============================================================================

function createAvailableTypesMockPrisma(t: TestContext, initialUser: any) {
  let userState = { ...initialUser };
  let clientProfile = initialUser.clientProfile;
  let providerProfile = initialUser.providerProfile;
  let providerGamification = initialUser.gamification;
  let affiliateProfile = initialUser.affiliateProfile;

  const userUpdateSpy = t.mock.fn(async (args: any) => { userState = { ...userState, ...args.data }; return { ...userState }; });
  const clientCreateSpy = t.mock.fn((args: any) => { clientProfile = { id: 'c1', ...args.data }; return clientProfile; });
  const providerCreateSpy = t.mock.fn((args: any) => { providerProfile = { id: 'p1', ...args.data }; return providerProfile; });
  const gamificationCreateSpy = t.mock.fn((args: any) => { providerGamification = { id: 'g1', ...args.data }; return providerGamification; });
  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateProfile = { id: 'a1', ...args.data }; return affiliateProfile; });

  const tx = {
    user: { update: userUpdateSpy },
    clientProfile: { findUnique: async () => clientProfile, create: clientCreateSpy },
    providerProfile: { findUnique: async () => providerProfile, create: providerCreateSpy },
    providerGamification: { findUnique: async () => providerGamification, create: gamificationCreateSpy },
    affiliateProfile: { findUnique: async () => affiliateProfile, create: affiliateCreateSpy }
  };

  const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));

  const prismaMock = {
    user: { findUnique: async () => ({ ...userState, clientProfile, providerProfile, affiliateProfile, gamification: providerGamification }) },
    $transaction: transactionSpy
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { transactionSpy, userUpdateSpy, clientCreateSpy, providerCreateSpy, gamificationCreateSpy, affiliateCreateSpy };
}

async function loadServiceForAvailableTypes(t: TestContext, userFixture: any) {
  const mocks = createAvailableTypesMockPrisma(t, userFixture);
  const moduleUrl = `./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accountManagementService } = await import(moduleUrl);
  return { accountManagementService, ...mocks };
}

function baseAvailableTypesUserFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'user-1', firstName: 'Amr', lastName: 'Okasha', avatarUrl: null, email: 'amr@example.com',
    phoneNumber: null, idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null, accountHolderName: null, idDocumentUrl: null,
    roles: null, activeRole: null, accountType: 'CLIENT_INDIVIDUAL',
    clientProfile: null, providerProfile: null, affiliateProfile: null, gamification: null,
    ...overrides
  };
}

test('getAvailableAccountTypes: User.roles repair + missing role-state repair happen inside the SAME transaction', async (t) => {
  const { accountManagementService, transactionSpy, userUpdateSpy, clientCreateSpy } =
    await loadServiceForAvailableTypes(t, baseAvailableTypesUserFixture());

  await accountManagementService.getAvailableAccountTypes('user-1');

  assert.equal(transactionSpy.mock.callCount(), 1);
  assert.equal(userUpdateSpy.mock.callCount(), 1);
  assert.equal(clientCreateSpy.mock.callCount(), 1);
});

test('getAvailableAccountTypes: no transaction opened at all when nothing needs repairing', async (t) => {
  const { accountManagementService, transactionSpy } = await loadServiceForAvailableTypes(t, baseAvailableTypesUserFixture({
    roles: ['CLIENT'], activeRole: 'CLIENT', clientProfile: { id: 'c1' }
  }));

  await accountManagementService.getAvailableAccountTypes('user-1');

  assert.equal(transactionSpy.mock.callCount(), 0);
});

test('getAvailableAccountTypes: PROVIDER role with an existing ProviderProfile but missing ProviderGamification is repaired', async (t) => {
  const { accountManagementService, transactionSpy, providerCreateSpy, gamificationCreateSpy } = await loadServiceForAvailableTypes(t, baseAvailableTypesUserFixture({
    roles: ['CLIENT', 'PROVIDER'], activeRole: 'CLIENT', clientProfile: { id: 'c1' },
    providerProfile: { id: 'p1' }, gamification: null
  }));

  await accountManagementService.getAvailableAccountTypes('user-1');

  assert.equal(transactionSpy.mock.callCount(), 1);
  assert.equal(providerCreateSpy.mock.callCount(), 0);
  assert.equal(gamificationCreateSpy.mock.callCount(), 1);
});

test('getAvailableAccountTypes: repeated repair is idempotent — a second call finds nothing left to repair', async (t) => {
  const { accountManagementService, transactionSpy } = await loadServiceForAvailableTypes(t, baseAvailableTypesUserFixture());

  await accountManagementService.getAvailableAccountTypes('user-1');
  assert.equal(transactionSpy.mock.callCount(), 1);

  await accountManagementService.getAvailableAccountTypes('user-1');
  assert.equal(transactionSpy.mock.callCount(), 1); // still 1 — second call needed no repair
});
