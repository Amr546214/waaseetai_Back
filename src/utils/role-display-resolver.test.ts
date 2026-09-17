import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveRoleDisplayFields, resolveProviderProgression } from './role-display-resolver';

const legacy = {
  firstName: 'Legacy',
  lastName: 'User',
  avatarUrl: 'https://legacy.example/avatar.png',
  profileCompletionPercent: 42,
  currentLevel: 'مستكشف - المستوى 1',
  currentPoints: 5,
  pointsToNextLevel: 95
};

test('CLIENT active role resolves display/progression fields from ClientProfile', () => {
  const result = resolveActiveRoleDisplayFields({
    activeRole: 'CLIENT',
    legacy,
    clientProfile: {
      firstName: 'Client',
      lastName: 'Name',
      avatarUrl: 'https://client.example/avatar.png',
      completionPercentage: 60,
      currentLevel: 'باحث',
      currentPoints: 200,
      pointsToNextLevel: 100
    }
  });

  assert.deepEqual(result, {
    firstName: 'Client',
    lastName: 'Name',
    avatarUrl: 'https://client.example/avatar.png',
    profileCompletionPercent: 60,
    currentLevel: 'باحث',
    currentPoints: 200,
    pointsToNextLevel: 100
  });
});

test('PROVIDER active role resolves name/avatar/completion from ProviderProfile and progression from ProviderGamification/LEVEL_MATRIX', () => {
  const result = resolveActiveRoleDisplayFields({
    activeRole: 'PROVIDER',
    legacy,
    providerProfile: {
      firstName: 'Provider',
      lastName: 'Name',
      avatarUrl: 'https://provider.example/avatar.png',
      completionPercentage: 80
    },
    // 50 points is exactly the level-2 ("مستكشف") threshold in LEVEL_MATRIX.
    providerGamification: { points: 50, currentLevelIndex: 2 }
  });

  assert.equal(result.firstName, 'Provider');
  assert.equal(result.lastName, 'Name');
  assert.equal(result.avatarUrl, 'https://provider.example/avatar.png');
  assert.equal(result.profileCompletionPercent, 80);
  // currentLevel must come from LEVEL_MATRIX[index].title, not ClientProfile
  // and not the legacy User.currentLevel string.
  assert.equal(result.currentLevel, 'مستكشف');
  assert.equal(result.currentPoints, 50);
  // Level 3 ("باحث") requires 150 points -> gap is 100.
  assert.equal(result.pointsToNextLevel, 100);
});

test('AFFILIATE active role resolves name/avatar/level/completion from AffiliateProfile, preserves legacy points fields as-is', () => {
  const result = resolveActiveRoleDisplayFields({
    activeRole: 'AFFILIATE',
    legacy,
    affiliateProfile: {
      firstName: 'Affiliate',
      lastName: 'Name',
      avatarUrl: 'https://affiliate.example/avatar.png',
      completionPercentage: 30,
      currentLevel: 'موصل'
    }
  });

  assert.equal(result.firstName, 'Affiliate');
  assert.equal(result.lastName, 'Name');
  assert.equal(result.avatarUrl, 'https://affiliate.example/avatar.png');
  assert.equal(result.profileCompletionPercent, 30);
  assert.equal(result.currentLevel, 'موصل');
  // No points-based progression concept exists for affiliates yet: preserve
  // the legacy User values verbatim instead of inventing fake progression.
  assert.equal(result.currentPoints, legacy.currentPoints);
  assert.equal(result.pointsToNextLevel, legacy.pointsToNextLevel);
});

test('same underlying profiles resolve to different values when activeRole switches CLIENT -> PROVIDER', () => {
  const params = {
    legacy,
    clientProfile: {
      firstName: 'Client-Side',
      lastName: 'Persona',
      avatarUrl: 'https://client.example/avatar.png',
      completionPercentage: 60,
      currentLevel: 'باحث',
      currentPoints: 200,
      pointsToNextLevel: 100
    },
    providerProfile: {
      firstName: 'Provider-Side',
      lastName: 'Persona',
      avatarUrl: 'https://provider.example/avatar.png',
      completionPercentage: 80
    },
    providerGamification: { points: 0, currentLevelIndex: 1 }
  };

  const asClient = resolveActiveRoleDisplayFields({ activeRole: 'CLIENT', ...params });
  const asProvider = resolveActiveRoleDisplayFields({ activeRole: 'PROVIDER', ...params });

  assert.notEqual(asClient.firstName, asProvider.firstName);
  assert.notEqual(asClient.profileCompletionPercent, asProvider.profileCompletionPercent);
  assert.notEqual(asClient.currentLevel, asProvider.currentLevel);
  assert.notEqual(asClient.currentPoints, asProvider.currentPoints);
});

test('a null/empty role-specific field falls back to the legacy User value', () => {
  const result = resolveActiveRoleDisplayFields({
    activeRole: 'CLIENT',
    legacy,
    clientProfile: {
      firstName: null,
      lastName: '   ', // whitespace-only counts as empty
      avatarUrl: null,
      completionPercentage: 0,
      currentLevel: null,
      currentPoints: 0,
      pointsToNextLevel: null
    }
  });

  assert.equal(result.firstName, legacy.firstName);
  assert.equal(result.lastName, legacy.lastName);
  assert.equal(result.avatarUrl, legacy.avatarUrl);
  assert.equal(result.currentLevel, legacy.currentLevel);
  assert.equal(result.pointsToNextLevel, legacy.pointsToNextLevel);
  // 0 is a legitimate value, not a trigger for fallback.
  assert.equal(result.profileCompletionPercent, 0);
  assert.equal(result.currentPoints, 0);
});

test('a missing role profile (undefined/null) does not crash and falls back to legacy for every field', () => {
  const asClient = resolveActiveRoleDisplayFields({ activeRole: 'CLIENT', legacy, clientProfile: null });
  assert.deepEqual(asClient, legacy);

  const asProvider = resolveActiveRoleDisplayFields({ activeRole: 'PROVIDER', legacy, providerProfile: undefined, providerGamification: null });
  assert.deepEqual(asProvider, legacy);

  const asAffiliate = resolveActiveRoleDisplayFields({ activeRole: 'AFFILIATE', legacy, affiliateProfile: undefined });
  assert.deepEqual(asAffiliate, legacy);
});

// Phase 3C bug fix: provider-profile.service.ts's getPublicProfile() previously
// derived its levelName inline, defaulting a missing
// ProviderGamification.currentLevelIndex to 1 BEFORE checking any fallback — so
// LEVEL_MATRIX index 1 ("زائر") always matched and profile.user.currentLevel was
// never actually reached. getPublicProfile now delegates to
// resolveProviderProgression (this file) for that derivation instead, so these
// tests pin down the exact two scenarios the bug report described, directly
// against the pure function driving the fix.

test('resolveProviderProgression: a completely missing ProviderGamification row falls back to the given legacy currentLevel, never LEVEL_MATRIX', () => {
  const result = resolveProviderProgression(null, { ...legacy, currentLevel: 'مستوى قديم مخصص' });

  assert.equal(result.currentLevel, 'مستوى قديم مخصص');
  // The old bug always produced 'زائر' (LEVEL_MATRIX index 1's title) here,
  // regardless of the legacy value — confirm that never happens now.
  assert.notEqual(result.currentLevel, 'زائر');
});

test('resolveProviderProgression: an existing ProviderGamification row derives currentLevel from LEVEL_MATRIX, ignoring the legacy value', () => {
  // 50 points / currentLevelIndex 2 -> LEVEL_MATRIX[1] ("مستكشف").
  const result = resolveProviderProgression({ points: 50, currentLevelIndex: 2 }, { ...legacy, currentLevel: 'يجب تجاهل هذه القيمة' });

  assert.equal(result.currentLevel, 'مستكشف');
  assert.notEqual(result.currentLevel, legacy.currentLevel);
});

test('resolveProviderProgression: a currentLevelIndex with no matching LEVEL_MATRIX entry falls back to LEVEL_MATRIX[0] ("زائر"), not a crash', () => {
  const result = resolveProviderProgression({ points: 0, currentLevelIndex: 999 }, legacy);

  assert.equal(result.currentLevel, 'زائر');
});
