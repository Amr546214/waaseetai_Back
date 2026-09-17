import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.2A: the generic /profiles/setup endpoint (profile-setup.service.ts)
// used to unconditionally write `User.profileCompletionPercent = 100` for
// whatever role the request happened to target (selected by accountType, not
// activeRole). It must now: (1) select the target role via activeRole,
// (2) write a REAL calculated completion score to the role's OWN profile
// table for CLIENT/PROVIDER, and (3) reject AFFILIATE/any unsupported role
// outright — never writing User=100, never falling through to PROVIDER.

function createSetupMockPrisma(t: TestContext) {
  const state: any = {
    user: { id: 'user-1', firstName: 'Amr', lastName: 'Okasha', phoneNumber: '0500000000', avatarUrl: null },
    clientProfile: { userId: 'user-1', bio: null, companyName: null, industry: null, completionPercentage: 0 },
    providerProfile: { userId: 'user-1', bio: null, skills: null, hourlyRate: null, completionPercentage: 0 }
  };

  const userUpdateSpy = t.mock.fn((args: any) => { state.user = { ...state.user, ...args.data }; return { ...state.user }; });
  const clientUpsertSpy = t.mock.fn((args: any) => { state.clientProfile = { ...state.clientProfile, ...args.update }; return { ...state.clientProfile }; });
  const clientUpdateSpy = t.mock.fn((args: any) => { state.clientProfile = { ...state.clientProfile, ...args.data }; return { ...state.clientProfile }; });
  const providerUpsertSpy = t.mock.fn((args: any) => { state.providerProfile = { ...state.providerProfile, ...args.update }; return { ...state.providerProfile }; });
  const providerUpdateSpy = t.mock.fn((args: any) => { state.providerProfile = { ...state.providerProfile, ...args.data }; return { ...state.providerProfile }; });

  const tx = {
    user: { update: userUpdateSpy, findUnique: async () => ({ ...state.user }) },
    clientProfile: { upsert: clientUpsertSpy, update: clientUpdateSpy },
    providerProfile: { upsert: providerUpsertSpy, update: providerUpdateSpy }
  };

  t.mock.module('../config/db', {
    namedExports: {
      prisma: { ...tx, $transaction: async (fn: any) => fn(tx) }
    }
  });

  return { userUpdateSpy, clientUpsertSpy, clientUpdateSpy, providerUpsertSpy, providerUpdateSpy };
}

async function loadServiceWithFixture(t: TestContext) {
  const spies = createSetupMockPrisma(t);
  const moduleUrl = `./profile-setup.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { profileSetupService } = await import(moduleUrl);
  return { profileSetupService, ...spies };
}

test('CLIENT setup: writes a real calculated ClientProfile.completionPercentage, not User=100', async (t) => {
  const { profileSetupService, clientUpdateSpy, userUpdateSpy } = await loadServiceWithFixture(t);

  await profileSetupService.saveProfileSetup('user-1', 'CLIENT', { bio: 'a bio', companyName: 'Acme', industry: 'Tech' });

  const completionCall = clientUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');

  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('profileCompletionPercent' in call.arguments[0].data, false);
  }
});

test('PROVIDER setup: writes a real calculated ProviderProfile.completionPercentage, not User=100', async (t) => {
  const { profileSetupService, providerUpdateSpy, userUpdateSpy } = await loadServiceWithFixture(t);

  await profileSetupService.saveProfileSetup('user-1', 'PROVIDER', { bio: 'a'.repeat(60), skills: ['a', 'b'], hourlyRate: 100 });

  const completionCall = providerUpdateSpy.mock.calls.find((c: any) => 'completionPercentage' in c.arguments[0].data);
  assert.notEqual(completionCall, undefined);
  assert.equal(typeof completionCall.arguments[0].data.completionPercentage, 'number');

  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('profileCompletionPercent' in call.arguments[0].data, false);
  }
});

test('AFFILIATE (or any unsupported role) setup: rejected outright, no User=100, no fallthrough to ProviderProfile', async (t) => {
  const { profileSetupService, providerUpsertSpy, clientUpsertSpy, userUpdateSpy } = await loadServiceWithFixture(t);

  await assert.rejects(
    () => profileSetupService.saveProfileSetup('user-1', 'AFFILIATE', { bio: 'x' }),
    /غير مدعوم/
  );

  assert.equal(providerUpsertSpy.mock.callCount(), 0);
  assert.equal(clientUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('ADMIN (unsupported role) setup: also rejected, never falls through to PROVIDER', async (t) => {
  const { profileSetupService, providerUpsertSpy } = await loadServiceWithFixture(t);

  await assert.rejects(
    () => profileSetupService.saveProfileSetup('user-1', 'ADMIN', {}),
    /غير مدعوم/
  );

  assert.equal(providerUpsertSpy.mock.callCount(), 0);
});
