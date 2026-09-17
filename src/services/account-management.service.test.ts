import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

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
  assert.equal(result.user.currentLevel, 'مستكشف');
  assert.equal(result.user.currentPoints, 50);
  assert.notEqual(result.user.firstName, legacyUser.firstName);
});
