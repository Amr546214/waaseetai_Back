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
