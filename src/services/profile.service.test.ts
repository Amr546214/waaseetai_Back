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
  const clientUpdateSpy = t.mock.fn((args: any) => ({ id: 'cp-1', ...args.data }));
  const findUniqueSpy = t.mock.fn(async (_args: any) => userFixture);
  t.mock.module('../config/db', {
    // See account-management.service.test.ts for why this must be
    // `namedExports`, not `exports` — Node 22.23.2's mock.module() silently
    // ignores the unrecognized `exports` key, leaving prisma undefined.
    namedExports: {
      prisma: {
        user: {
          findUnique: findUniqueSpy,
          update: updateSpy
        },
        clientProfile: { update: clientUpdateSpy }
      }
    }
  });
  // Cache-bust so each test gets a fresh module graph bound to its own mock —
  // node's ESM cache would otherwise keep serving the first test's instance.
  const moduleUrl = `./profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(moduleUrl);
  return { profileService, updateSpy, findUniqueSpy, clientUpdateSpy };
}

test('getProfile (CLIENT) resolves role-specific fields, recomputes the completion with its missing items, and never writes User', async (t) => {
  const { profileService, updateSpy, clientUpdateSpy } = await loadProfileServiceWithFixture(t, { ...baseUser, accountType: 'CLIENT_INDIVIDUAL' });

  const result = await profileService.getProfile('user-1');

  assert.equal(result.currentProfileData.firstName, 'Client');
  assert.equal(result.currentProfileData.lastName, 'Persona');
  assert.equal(result.currentProfileData.avatarUrl, 'https://client.example/avatar.png');
  // individual: avatar 15 + name 15 = 30 (the stored 60 predates the formula; companyName is not scored for individuals)
  assert.equal(result.currentProfileData.profileCompletionPercent, 30);
  assert.equal(result.currentProfileData.completionPercentage, 30);
  assert.deepEqual(result.currentProfileData.missingItems.map((i: any) => i.key), ['bio', 'industry', 'idNumber', 'payout']);
  assert.equal(result.currentProfileData.currentLevel, 'باحث');
  assert.equal(result.currentProfileData.currentPoints, 200);
  assert.equal(result.currentProfileData.pointsToNextLevel, 100);

  // The User row is never written by a GET; only the stored client completion is brought in sync.
  assert.equal(updateSpy.mock.callCount(), 0);
  assert.equal(clientUpdateSpy.mock.callCount(), 1);
  assert.equal(clientUpdateSpy.mock.calls[0].arguments[0].data.completionPercentage, 30);
});

test('getProfile (CLIENT_COMPANY) scores the company fields', async (t) => {
  const company = { ...baseUser, accountType: 'CLIENT_COMPANY', clientProfile: { ...baseUser.clientProfile, companyName: 'Acme', companySize: '11-50', industry: 'IT', website: 'https://a.example', completionPercentage: 0 } };
  const { profileService } = await loadProfileServiceWithFixture(t, company);
  const result = await profileService.getProfile('user-1');
  // avatar 10 + name 10 + companyName 10 + companySize 10 + industry 10 + website 10 = 60
  assert.equal(result.currentProfileData.profileCompletionPercent, 60);
  assert.deepEqual(result.currentProfileData.missingItems.map((i: any) => i.key), ['bio', 'idNumber', 'payout']);
});

test('getProfile (CLIENT): the stored value is not rewritten when it is already correct', async (t) => {
  const { profileService, clientUpdateSpy } = await loadProfileServiceWithFixture(t, { ...baseUser, accountType: 'CLIENT_INDIVIDUAL', clientProfile: { ...baseUser.clientProfile, completionPercentage: 30 } });
  await profileService.getProfile('user-1');
  assert.equal(clientUpdateSpy.mock.callCount(), 0);
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
// Deployment-safety regression coverage (P-LG-012 affiliate commission
// engine rollout). AffiliateProfile.level exists in prisma/schema.prisma but
// its migration has NOT been applied to DEV/LIVE. getProfile()'s
// `include: { affiliateProfile: true }` previously fetched ALL of
// AffiliateProfile's default scalars — this would have requested the
// not-yet-existing `level` column and 500'd this endpoint for every
// AFFILIATE-active user. `roleProfile` is spread wholesale into the API
// response, so the fix must preserve every OTHER existing field.
// ============================================================================

test('getProfile (AFFILIATE): the affiliateProfile relation is select-restricted, never requests `level`, and still resolves role-specific fields from a pre-migration-shaped fixture', async (t) => {
  const affiliateUserFixture = {
    ...baseUser,
    activeRole: 'AFFILIATE',
    accountType: 'MARKETING_BROKER',
    clientProfile: null,
    providerProfile: null,
    gamification: null,
    // Shaped exactly like the CURRENT (pre-migration) DB row would actually
    // look — every existing AffiliateProfile scalar present, `level` absent.
    affiliateProfile: {
      id: 'aff-1',
      userId: 'user-1',
      referralSlug: 'khalid-1',
      currentLevel: 'مساعد',
      commissionRatePercentage: 5,
      notifyOnNewReferral: true,
      sharePerformanceStats: false,
      firstName: 'خالد',
      lastName: 'الغامدي',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      bio: null,
      bankName: null,
      accountHolderName: null,
      iban: null,
      swiftCode: null,
      identityVerified: false,
      kycDocumentUrl: null,
      payoutMethod: 'BANK_TRANSFER',
      minimumPayoutAmount: 300,
      completionPercentage: 45,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01')
    }
  };
  const { profileService, updateSpy, findUniqueSpy } = await loadProfileServiceWithFixture(t, affiliateUserFixture);

  const result = await profileService.getProfile('user-1');

  assert.equal(result.currentProfileData.firstName, 'خالد');
  assert.equal(result.currentProfileData.lastName, 'الغامدي');
  assert.equal(result.currentProfileData.referralSlug, 'khalid-1');
  assert.equal('level' in result.currentProfileData, false);
  assert.equal(updateSpy.mock.callCount(), 0);

  assert.equal(findUniqueSpy.mock.callCount(), 1);
  const args = findUniqueSpy.mock.calls[0].arguments[0];
  const affiliateInclude = args.include.affiliateProfile;
  assert.ok(affiliateInclude.select, 'affiliateProfile must be select-restricted, not a bare `true`');
  assert.equal('level' in affiliateInclude.select, false);
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

function createDisplayWriteMockPrisma(t: TestContext, userFixture: any, existingClientProfile: any = null) {
  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));
  const clientUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));
  // Phase 3D.2A: updateProfile()/updateTab() now follow a CLIENT upsert with
  // a completionPercentage recalculation write — this mock must support that
  // second call (a plain pass-through no-op) so these pre-existing Phase
  // 3D.1 display-write tests keep exercising the real CLIENT code path
  // instead of crashing on an unmocked method.
  const clientUpdateSpy = t.mock.fn((args: any) => ({ ...args.data }));
  const providerUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));
  const affiliateUpsertSpy = t.mock.fn((args: any) => ({ ...args.create, ...args.update }));

  const tx = {
    user: {
      findUnique: async () => userFixture,
      update: userUpdateSpy,
      updateMany: userUpdateSpy
    },
    clientProfile: { upsert: clientUpsertSpy, update: clientUpdateSpy, findUnique: async () => existingClientProfile },
    providerProfile: { upsert: providerUpsertSpy, update: t.mock.fn((args: any) => ({ id: 'p1', ...args.data })), findUnique: async () => ({ userId: 'user-1', skills: [], portfolioItems: [], user: {} }) },
    affiliateProfile: { upsert: affiliateUpsertSpy, update: t.mock.fn((args: any) => ({ id: 'a1', ...args.data })), findUnique: async () => ({ avatarUrl: null, bio: null, iban: null, marketingChannels: [], user: {} }) }
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

async function loadProfileServiceForUpdate(t: TestContext, userFixture: any, existingClientProfile: any = null) {
  const spies = createDisplayWriteMockPrisma(t, userFixture, existingClientProfile);
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

// Deployment-safety regression coverage (P-LG-012 affiliate commission
// engine rollout). AffiliateProfile.level exists in prisma/schema.prisma but
// its migration has NOT been applied to DEV/LIVE. This upsert's return value
// (`profileResult`) is forwarded as-is into the API response, so it
// previously had no `select` at all (full default selection) — this would
// have requested the not-yet-existing `level` column and 500'd this
// AFFILIATE-active profile update.
test('updateProfile (AFFILIATE active): the upsert selects AffiliateProfile scalars explicitly and never requests `level`', async (t) => {
  const { profileService, affiliateUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateProfile('user-1', 'AFFILIATE', { firstName: 'Affiliate', lastName: 'Persona' });

  assert.equal(affiliateUpsertSpy.mock.callCount(), 1);
  const args = affiliateUpsertSpy.mock.calls[0].arguments[0];
  assert.ok(args.select, 'must pass an explicit select');
  assert.equal('level' in args.select, false);
  // The full pre-existing scalar shape must still be present (response-shape
  // preservation) — spot-check a representative field.
  assert.equal(args.select.id, true);
  assert.equal(args.select.completionPercentage, true);
});

// ============================================================================
// Payout P2-A — ProviderProfile.paypalPayoutEmail via updateProfile().
// ============================================================================

test('A. updateProfile (PROVIDER active): a paypalPayoutEmail is NOT saved directly any more (#33: it needs the email-OTP flow), and nothing is written', async (t) => {
  const { profileService, providerUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await assert.rejects(
    () => profileService.updateProfile('user-1', 'PROVIDER', { paypalPayoutEmail: 'provider@paypal-sandbox.example' } as any),
    (e: any) => e.statusCode === 400 && /رمز تحقق/.test(e.message)
  );
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
});

test('D. updateProfile (PROVIDER active): omitting paypalPayoutEmail never falls back to User.email', async (t) => {
  const userWithEmail = { ...activeUser, email: 'login@example.com' };
  const { profileService, providerUpsertSpy } = await loadProfileServiceForUpdate(t, userWithEmail);

  await profileService.updateProfile('user-1', 'PROVIDER', {
    firstName: 'Okasha'
  } as any);

  assert.equal(providerUpsertSpy.mock.callCount(), 1);
  const providerCall = providerUpsertSpy.mock.calls[0].arguments[0];
  assert.equal('paypalPayoutEmail' in providerCall.update, false);
  assert.equal('paypalPayoutEmail' in providerCall.create, false);
});

test('updateProfile (AFFILIATE active): paypalPayoutEmail is stripped, not sent to AffiliateProfile', async (t) => {
  const { profileService, affiliateUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateProfile('user-1', 'AFFILIATE', {
    firstName: 'Affiliate',
    paypalPayoutEmail: 'someone@example.com'
  } as any);

  assert.equal(affiliateUpsertSpy.mock.callCount(), 1);
  const affiliateCall = affiliateUpsertSpy.mock.calls[0].arguments[0];
  assert.equal('paypalPayoutEmail' in affiliateCall.update, false);
});

test('updateProfile: an unchanged phoneNumber is ignored and a pending account is NOT activated by a profile save (AUD-FND-000036)', async (t) => {
  const pendingUser = { id: 'user-1', status: 'PENDING_VERIFICATION', phoneNumber: '0500000000' };
  const { profileService, userUpdateSpy, clientUpsertSpy } = await loadProfileServiceForUpdate(t, pendingUser);

  await profileService.updateProfile('user-1', 'CLIENT', { phoneNumber: '0500000000' });

  // the number did not change, so nothing is written to User at all (a changed number needs the email-OTP flow, #26)
  assert.equal(userUpdateSpy.mock.callCount(), 0);
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
  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].where.status, 'ACTIVE');
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

// ============================================================================
// Phase 3D.2A — CLIENT completion writes for updateProfile()/updateTab().
//
// A completion-relevant CLIENT mutation must recalculate
// ClientProfile.completionPercentage from the FINAL post-write state, using
// the shared historical CLIENT calculator. It must never fire for
// PROVIDER/AFFILIATE, and must never write User.profileCompletionPercent.
// ============================================================================

function createCompletionMockPrisma(t: TestContext, userFixture: any) {
  let clientProfileState: any = { userId: 'user-1', firstName: null, lastName: null, avatarUrl: null, bio: null, companyName: null, idNumber: null, bankName: null, completionPercentage: 0 };
  let providerProfileState: any = { userId: 'user-1', completionPercentage: 0 };
  let affiliateProfileState: any = { userId: 'user-1', completionPercentage: 0 };

  const userUpdateSpy = t.mock.fn((args: any) => ({ ...userFixture, ...args.data }));
  const clientUpsertSpy = t.mock.fn((args: any) => { clientProfileState = { ...clientProfileState, ...args.update }; return { ...clientProfileState }; });
  const clientUpdateSpy = t.mock.fn((args: any) => { clientProfileState = { ...clientProfileState, ...args.data }; return { ...clientProfileState }; });
  const providerUpsertSpy = t.mock.fn((args: any) => { providerProfileState = { ...providerProfileState, ...args.update }; return { ...providerProfileState }; });
  const providerUpdateSpy = t.mock.fn((args: any) => { providerProfileState = { ...providerProfileState, ...args.data }; return { ...providerProfileState }; });
  const affiliateUpsertSpy = t.mock.fn((args: any) => { affiliateProfileState = { ...affiliateProfileState, ...args.update }; return { ...affiliateProfileState }; });
  const affiliateUpdateSpy = t.mock.fn((args: any) => { affiliateProfileState = { ...affiliateProfileState, ...args.data }; return { ...affiliateProfileState }; });

  const tx = {
    user: { findUnique: async () => ({ ...userFixture }), update: userUpdateSpy, updateMany: userUpdateSpy },
    clientProfile: { upsert: clientUpsertSpy, update: clientUpdateSpy },
    providerProfile: { upsert: providerUpsertSpy, update: providerUpdateSpy, findUnique: async () => ({ userId: 'user-1', skills: [], portfolioItems: [], user: {} }) },
    affiliateProfile: {
      upsert: affiliateUpsertSpy,
      update: affiliateUpdateSpy,
      findUnique: async () => ({ avatarUrl: 'https://x/a.png', bio: null, iban: null, marketingChannels: [], user: {} })
    }
  };

  t.mock.module('../config/db', {
    namedExports: { prisma: { ...tx, $transaction: async (fn: any) => fn(tx) } }
  });

  return { userUpdateSpy, clientUpsertSpy, clientUpdateSpy, providerUpsertSpy, providerUpdateSpy, affiliateUpsertSpy, affiliateUpdateSpy };
}

async function loadProfileServiceForCompletion(t: TestContext, userFixture: any) {
  const spies = createCompletionMockPrisma(t, userFixture);
  const moduleUrl = `./profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { profileService } = await import(moduleUrl);
  return { profileService, ...spies };
}

test('updateProfile (CLIENT): recalculates ClientProfile.completionPercentage from the final state', async (t) => {
  const { profileService, clientUpdateSpy } = await loadProfileServiceForCompletion(t, { id: 'user-1', status: 'ACTIVE', phoneNumber: '0500000000' });

  await profileService.updateProfile('user-1', 'CLIENT', {
    firstName: 'Amr',
    lastName: 'Okasha',
    bio: 'a bio',
    companyName: 'Acme'
  } as any);

  const completionCall = clientUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');
  assert.equal(completionCall.arguments[0].data.completionPercentage > 0, true);
});

test('updateTab (CLIENT, basics): a display-field mutation recalculates ClientProfile.completionPercentage', async (t) => {
  const { profileService, clientUpdateSpy } = await loadProfileServiceForCompletion(t, { id: 'user-1', status: 'ACTIVE', phoneNumber: '0500000000' });

  await profileService.updateTab('user-1', 'basics', { firstName: 'Amr', lastName: 'Okasha' }, 'CLIENT');

  const completionCall = clientUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');
});

test('updateProfile/updateTab (CLIENT): neither writes User.profileCompletionPercent', async (t) => {
  const { profileService, userUpdateSpy } = await loadProfileServiceForCompletion(t, { id: 'user-1', status: 'ACTIVE', phoneNumber: '0500000000' });

  await profileService.updateProfile('user-1', 'CLIENT', { firstName: 'Amr', lastName: 'Okasha' } as any);
  await profileService.updateTab('user-1', 'basics', { firstName: 'Amr' }, 'CLIENT');

  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('profileCompletionPercent' in call.arguments[0].data, false);
  }
});

test('updateProfile (PROVIDER/AFFILIATE): each role recomputes only ITS OWN completion row; the client row is never touched', async (t) => {
  const { profileService, clientUpdateSpy, providerUpdateSpy, affiliateUpdateSpy } = await loadProfileServiceForCompletion(t, { id: 'user-1', status: 'ACTIVE' });

  await profileService.updateProfile('user-1', 'PROVIDER', { firstName: 'Okasha', lastName: 'Expert' } as any);
  await profileService.updateProfile('user-1', 'AFFILIATE', { firstName: 'Aff', lastName: 'Iliate' } as any);

  assert.equal(clientUpdateSpy.mock.callCount(), 0);
  // PROVIDER: one completion write (e.g. PayPal saved through this endpoint); AFFILIATE: one (avatar/bio are scored inputs).
  assert.equal(providerUpdateSpy.mock.callCount(), 1);
  assert.equal(typeof providerUpdateSpy.mock.calls[0].arguments[0].data.completionPercentage, 'number');
  assert.equal(affiliateUpdateSpy.mock.callCount(), 1);
  assert.equal(affiliateUpdateSpy.mock.calls[0].arguments[0].data.completionPercentage, 20); // the avatar on the profile row
});

// ============================================================================
// Phase 3D.2A — role isolation regression: a CLIENT-active completion write
// must never touch Provider/Affiliate completion rows, and vice versa.
// ============================================================================

test('role isolation: CLIENT completion write never changes Provider/Affiliate completion rows', async (t) => {
  const { profileService, clientUpdateSpy, providerUpsertSpy, providerUpdateSpy, affiliateUpsertSpy } =
    await loadProfileServiceForCompletion(t, { id: 'user-1', status: 'ACTIVE', phoneNumber: '0500000000' });

  await profileService.updateProfile('user-1', 'CLIENT', { firstName: 'Amr', lastName: 'Okasha' } as any);

  assert.equal(clientUpdateSpy.mock.callCount() > 0, true);
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.equal(providerUpdateSpy.mock.callCount(), 0);
  assert.equal(affiliateUpsertSpy.mock.callCount(), 0);
});

// ============================================================================
// Client PayPal payout — PUT /profiles/update/banking + GET /profiles/me
// ============================================================================

test('updateTab banking (CLIENT + paypalPayoutEmail): saves only ClientProfile.paypalPayoutEmail, no bank fields, no PENDING_VERIFICATION', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy, providerUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  const result = await profileService.updateTab('user-1', 'banking', { paypalPayoutEmail: '  Pay@Example.COM ' }, 'CLIENT');

  assert.equal(clientUpsertSpy.mock.callCount(), 1);
  const args = clientUpsertSpy.mock.calls[0].arguments[0];
  assert.equal(args.update.paypalPayoutEmail, 'pay@example.com');
  assert.equal(args.update.paymentType, 'paypal');
  assert.equal(args.create.paymentType, 'paypal');
  for (const k of ['iban', 'accountHolder', 'bankName']) {
    assert.equal(k in args.update, false);
    assert.equal(k in args.create, false);
  }
  assert.equal(userUpdateSpy.mock.callCount(), 0); // status untouched
  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.match(result.message, /PayPal/);
});

test('updateTab banking (CLIENT): invalid PayPal email is rejected and nothing is written', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await assert.rejects(() => profileService.updateTab('user-1', 'banking', { paypalPayoutEmail: 'not-an-email' }, 'CLIENT'), /PayPal/);
  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateTab banking (CLIENT) without paypalPayoutEmail keeps the legacy PENDING_VERIFICATION behavior', async (t) => {
  const { profileService, userUpdateSpy, clientUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser);

  await profileService.updateTab('user-1', 'banking', { iban: 'SA00' }, 'CLIENT');
  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.status, 'PENDING_VERIFICATION');
});

test('getProfile (CLIENT) returns paypalPayoutEmail', async (t) => {
  const fixture = { ...baseUser, clientProfile: { ...baseUser.clientProfile, paypalPayoutEmail: 'pay@example.com' } };
  const { profileService } = await loadProfileServiceWithFixture(t, fixture);
  const result = await profileService.getProfile('user-1');
  assert.equal(result.currentProfileData.paypalPayoutEmail, 'pay@example.com');
});

test('updateTab banking (CLIENT): clearing the PayPal email also clears paymentType=\'paypal\' (no paypal type with null email)', async (t) => {
  const existing = { paymentType: 'paypal', paypalPayoutEmail: 'pay@example.com' };
  const { profileService, clientUpsertSpy, userUpdateSpy } = await loadProfileServiceForUpdate(t, activeUser, existing);
  for (const [i, cleared] of [null, ''].entries()) {
    await profileService.updateTab('user-1', 'banking', { paypalPayoutEmail: cleared }, 'CLIENT');
    const { update } = clientUpsertSpy.mock.calls[i].arguments[0];
    assert.equal(update.paypalPayoutEmail, null);
    assert.equal(update.paymentType, null);
  }
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('updateTab banking (CLIENT): clearing the PayPal email keeps a legacy bank paymentType', async (t) => {
  const { profileService, clientUpsertSpy } = await loadProfileServiceForUpdate(t, activeUser, { paymentType: 'bank', paypalPayoutEmail: null });
  await profileService.updateTab('user-1', 'banking', { paypalPayoutEmail: null }, 'CLIENT');
  assert.equal('paymentType' in clientUpsertSpy.mock.calls[0].arguments[0].update, false);
});
