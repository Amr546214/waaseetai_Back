import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// profile.service.ts's getProfile() must be pure read-only (Phase 3C, problem
// #1): it used to recompute a completion score and write it back to
// User.profileCompletionPercent as a side effect of a GET. These tests run
// against a fully mocked prisma client (mock.module intercepts '../config/db'
// before profile.service.ts is imported, so the real db.ts — which opens a
// pg Pool — never executes and no database connection is ever made) so we can
// assert prisma.user.update is never invoked, without touching a real DB.

const baseUser = {
  id: 'user-1',
  password: 'hashed',
  activeRole: 'CLIENT',
  accountType: 'CLIENT_INDIVIDUAL',
  firstName: 'Legacy',
  lastName: 'Name',
  avatarUrl: 'https://legacy.example/avatar.png',
  profileCompletionPercent: 42,
  currentLevel: 'مستكشف - المستوى 1',
  currentPoints: 5,
  pointsToNextLevel: 95,
  clientProfile: {
    firstName: 'Client',
    lastName: 'Persona',
    avatarUrl: 'https://client.example/avatar.png',
    completionPercentage: 60,
    currentLevel: 'باحث',
    currentPoints: 200,
    pointsToNextLevel: 100,
    companyName: 'Acme'
  },
  providerProfile: null,
  affiliateProfile: null,
  gamification: null
};

async function loadProfileServiceWithFixture(t: TestContext, userFixture: any) {
  const updateSpy = t.mock.fn();
  t.mock.module('../config/db', {
    // See account-management.service.test.ts for why this must be
    // `namedExports`, not `exports` — Node 22.23.2's mock.module() silently
    // ignores the unrecognized `exports` key, leaving prisma undefined.
    namedExports: {
      prisma: {
        user: {
          findUnique: async () => userFixture,
          update: updateSpy
        }
      }
    }
  });
  // Cache-bust so each test gets a fresh module graph bound to its own mock —
  // node's ESM cache would otherwise keep serving the first test's instance.
  const moduleUrl = `./profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(moduleUrl);
  return { profileService, updateSpy };
}

test('getProfile (CLIENT) resolves role-specific fields and never writes to the DB', async (t) => {
  const { profileService, updateSpy } = await loadProfileServiceWithFixture(t, baseUser);

  const result = await profileService.getProfile('user-1');

  assert.equal(result.currentProfileData.firstName, 'Client');
  assert.equal(result.currentProfileData.lastName, 'Persona');
  assert.equal(result.currentProfileData.avatarUrl, 'https://client.example/avatar.png');
  assert.equal(result.currentProfileData.profileCompletionPercent, 60);
  assert.equal(result.currentProfileData.currentLevel, 'باحث');
  assert.equal(result.currentProfileData.currentPoints, 200);
  assert.equal(result.currentProfileData.pointsToNextLevel, 100);

  // Read-side-effect removal (Phase 3C, problem #1): a GET must never mutate.
  assert.equal(updateSpy.mock.callCount(), 0);
});

test('getProfile (PROVIDER) with no ProviderProfile row does not crash and falls back to legacy fields', async (t) => {
  const providerUserMissingProfile = {
    ...baseUser,
    activeRole: 'PROVIDER',
    accountType: 'PROVIDER_INDIVIDUAL',
    clientProfile: null,
    providerProfile: null,
    gamification: null
  };
  const { profileService, updateSpy } = await loadProfileServiceWithFixture(t, providerUserMissingProfile);

  const result = await profileService.getProfile('user-1');

  assert.equal(result.currentProfileData.firstName, baseUser.firstName);
  assert.equal(result.currentProfileData.lastName, baseUser.lastName);
  assert.equal(result.currentProfileData.profileCompletionPercent, baseUser.profileCompletionPercent);
  assert.equal(result.currentProfileData.currentLevel, baseUser.currentLevel);
  assert.equal(updateSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.1 — role-specific display writes for updateProfile()/updateTab().
//
// firstName/lastName/avatarUrl must land on whichever profile matches the
// caller's CURRENTLY ACTIVE role, and NEVER on the legacy User row — editing
// one persona (e.g. PROVIDER) must never change another (CLIENT/AFFILIATE)
// or the legacy User columns. Each test below sets up a mocked `prisma`
// (via mock.module + namedExports, same Node-22-compatible convention as the
// tests above) with spies on every model's update/upsert method, so we can
// assert exactly one table was touched and the other three (User + the two
// other role profiles) were not.
// ============================================================================

function createDisplayWriteMockPrisma(t: TestContext, userFixture: any) {
  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));
  const clientUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));
  const providerUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));
  const affiliateUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));

  const tx = {
    user: {
      findUnique: async () => userFixture,
      update: userUpdateSpy
    },
    clientProfile: { upsert: clientUpsertSpy },
    providerProfile: { upsert: providerUpsertSpy },
    affiliateProfile: { upsert: affiliateUpsertSpy }
  };

  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        ...tx,
        $transaction: async (fn: any) => fn(tx)
      }
    }
  });

  return { userUpdateSpy, clientUpsertSpy, providerUpsertSpy, affiliateUpsertSpy };
}

async function loadProfileServiceForUpdate(t: TestContext, userFixture: any) {
  const spies = createDisplayWriteMockPrisma(t, userFixture);
  const moduleUrl = `./profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(moduleUrl);
  return { profileService, ...spies };
}

const activeUser = { id: 'user-1', status: 'ACTIVE' };

test('updateProfile (CLIENT active): display fields go to ClientProfile only — Provider/Affiliate/User untouched', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy, providerUpsertSpy, affiliateUpsertSpy } =
    await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateProfile('user-1', 'CLIENT', {
    firstName: 'NewFirst',
    lastName: 'NewLast',
    avatarUrl: 'https://new.example/avatar.png'
  });

  assert.equal(clientUpsertSpy.mock.callCount(), 1);
  const clientCall = clientUpsertSpy.mock.calls[0].arguments[0];
  assert.equal(clientCall.update.firstName, 'NewFirst');
  assert.equal(clientCall.update.lastName, 'NewLast');
  assert.equal(clientCall.update.avatarUrl, 'https://new.example/avatar.png');

  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
  // No phoneNumber and status already ACTIVE -> User must not be written at all.
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateProfile (PROVIDER active): display fields go to ProviderProfile only', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy, providerUpsertSpy, affiliateUpsertSpy } =
    await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateProfile('user-1', 'PROVIDER', {
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: 'https://new.example/provider-avatar.png'
  });

  assert.equal(providerUpsertSpy.mock.callCount(), 1);
  const providerCall = providerUpsertSpy.mock.calls[0].arguments[0];
  assert.equal(providerCall.update.firstName, 'Okasha');
  assert.equal(providerCall.update.lastName, 'Expert');
  assert.equal(providerCall.update.avatarUrl, 'https://new.example/provider-avatar.png');

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateProfile (AFFILIATE active): display fields go to AffiliateProfile only, incompatible fields stripped', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy, providerUpsertSpy, affiliateUpsertSpy } =
    await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateProfile('user-1', 'AFFILIATE', {
    firstName: 'Affiliate',
    lastName: 'Persona',
    avatarUrl: 'https://new.example/affiliate-avatar.png',
    bio: 'Affiliate bio',
    // Fields that don't exist on AffiliateProfile — must be stripped, not
    // sent to affiliateProfile.upsert (which would otherwise throw on an
    // unknown Prisma column).
    companyName: 'Should be dropped',
    skills: ['should', 'be', 'dropped']
  });

  assert.equal(affiliateUpsertSpy.mock.callCount(), 1);
  const affiliateCall = affiliateUpsertSpy.mock.calls[0].arguments[0];
  assert.equal(affiliateCall.update.firstName, 'Affiliate');
  assert.equal(affiliateCall.update.lastName, 'Persona');
  assert.equal(affiliateCall.update.avatarUrl, 'https://new.example/affiliate-avatar.png');
  assert.equal(affiliateCall.update.bio, 'Affiliate bio');
  assert.equal('companyName' in affiliateCall.update, false);
  assert.equal('skills' in affiliateCall.update, false);

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateProfile: legitimate identity-level behavior (phoneNumber, pending->active status) is preserved', async (t) => {
  const pendingUser = { id: 'user-1', status: 'PENDING_VERIFICATION' };
  const { profileService, userUpdateSpy, clientUpsertSpy } = await loadProfileServiceForUpdate(t, pendingUser);

  await profileService.updateProfile('user-1', 'CLIENT', { phoneNumber: '0500000000' });

  assert.equal(userUpdateSpy.mock.callCount(), 1);
  const userCall = userUpdateSpy.mock.calls[0].arguments[0];
  assert.equal(userCall.data.phoneNumber, '0500000000');
  assert.equal(userCall.data.status, 'ACTIVE');
  // firstName/lastName/avatarUrl were never in this request, so no profile
  // upsert should fire from an empty displayFields+profileData.
  assert.equal(clientUpsertSpy.mock.callCount(), 0);
});

test('updateTab: arbitrary/unrecognized body fields cannot be written to User', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateTab('user-1', 'basics', {
    firstName: 'X',
    someRandomField: 'malicious',
    isBanned: true,
    walletBalance: 999999
  }, 'CLIENT');

  // firstName is a display field -> routed to ClientProfile, not User.
  assert.equal(clientUpsertSpy.mock.callCount(), 1);
  assert.equal(clientUpsertSpy.mock.calls[0].arguments[0].update.firstName, 'X');

  // No allowlisted User field was present, so User must not be touched at
  // all — in particular, the arbitrary/dangerous fields must never reach it.
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateTab: legitimate allowlisted contact fields still reach User', async (t) => {
  const { profileService, userUpdateSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateTab('user-1', 'contact', {
    city: 'Riyadh',
    address: '123 Main St',
    region: 'Riyadh Region'
  }, 'CLIENT');

  assert.equal(userUpdateSpy.mock.callCount(), 1);
  const userCall = userUpdateSpy.mock.calls[0].arguments[0];
  assert.equal(userCall.data.city, 'Riyadh');
  assert.equal(userCall.data.address, '123 Main St');
  assert.equal(userCall.data.region, 'Riyadh Region');
});

test('updateTab (PROVIDER active): firstName/lastName/avatarUrl route to ProviderProfile, not User', async (t) => {
  const { profileService, userUpdateSpy, providerUpsertSpy, clientUpsertSpy, affiliateUpsertSpy } =
    await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateTab('user-1', 'basics', {
    firstName: 'Okasha',
    lastName: 'Expert',
    avatarUrl: 'https://new.example/provider-avatar.png'
  }, 'PROVIDER');

  assert.equal(providerUpsertSpy.mock.callCount(), 1);
  const providerCall = providerUpsertSpy.mock.calls[0].arguments[0];
  assert.equal(providerCall.update.firstName, 'Okasha');
  assert.equal(providerCall.update.lastName, 'Expert');
  assert.equal(providerCall.update.avatarUrl, 'https://new.example/provider-avatar.png');

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateTab: identity/banking tabs remain unaffected by the display-field allowlist change', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  const result = await profileService.updateTab('user-1', 'identity', { idNumber: '1234567890' }, 'CLIENT');

  // Unchanged pre-existing behavior: this branch only flags PENDING_VERIFICATION,
  // it never persists the submitted field data (mocked/no-op moderation flow).
  assert.equal(userUpdateSpy.mock.callCount(), 1);
  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.status, 'PENDING_VERIFICATION');
  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.match(result.message, /قيد التحقق/);
});

// ============================================================================
// Phase 3D.1 final review — no implicit "else means PROVIDER" fallback.
// CLIENT/PROVIDER/AFFILIATE must be the only roles that can ever write a role
// profile from these two entry points; ADMIN/SUPER_ADMIN/an unknown role must
// fail safely and must never fall through to ProviderProfile (or any other
// table).
// ============================================================================

test('updateProfile: an unsupported role (ADMIN) rejects and never falls through to ProviderProfile', async (t) => {
  const { profileService, clientUpsertSpy, providerUpsertSpy, affiliateUpsertSpy, userUpdateSpy } =
    await loadProfileServiceForUpdate(t, activeUser);

  await assert.rejects(
    () => profileService.updateProfile('user-1', 'ADMIN', { firstName: 'X', lastName: 'Y' }),
    /غير مدعوم/
  );

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateProfile: an unsupported role (SUPER_ADMIN) rejects and never falls through to ProviderProfile', async (t) => {
  const { profileService, providerUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await assert.rejects(
    () => profileService.updateProfile('user-1', 'SUPER_ADMIN', { avatarUrl: 'https://new.example/x.png' }),
    /غير مدعوم/
  );

  assert.equal(providerUpsertSpy.mock.callCount(), 0);
});

test('updateTab (via upsertActiveRoleDisplayFields): an unsupported role rejects and never falls through to ProviderProfile', async (t) => {
  const { profileService, clientUpsertSpy, providerUpsertSpy, affiliateUpsertSpy } =
    await loadProfileServiceForUpdate(t, activeUser);

  await assert.rejects(
    () => profileService.updateTab('user-1', 'basics', { firstName: 'X' }, 'ADMIN'),
    /غير مدعوم/
  );

  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
});

test('updateTab: an unsupported role with no display fields in the body does not throw (nothing role-specific to write)', async (t) => {
  const { profileService, userUpdateSpy, providerUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  // No firstName/lastName/avatarUrl in the body -> upsertActiveRoleDisplayFields
  // returns early before ever checking the role, so a legitimate
  // identity-only update (e.g. an ADMIN updating their city) must still work.
  await profileService.updateTab('user-1', 'contact', { city: 'Jeddah' }, 'ADMIN');

  assert.equal(userUpdateSpy.mock.callCount(), 1);
  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.city, 'Jeddah');
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
});

test('updateTab: `country` is dropped, not written to User (User has no country column)', async (t) => {
  const { profileService, userUpdateSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateTab('user-1', 'contact', { city: 'Jeddah', country: 'Saudi Arabia' }, 'CLIENT');

  assert.equal(userUpdateSpy.mock.callCount(), 1);
  const data = userUpdateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.city, 'Jeddah');
  assert.equal('country' in data, false);
});
