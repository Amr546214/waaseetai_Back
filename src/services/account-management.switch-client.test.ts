import { test } from 'node:test';
import assert from 'node:assert/strict';

// Kept in its own file with NO static import of the service: account-logs.service captures the real prisma
// at module load, so the service must be (re)imported only after '../config/db' is mocked.

test('switching to CLIENT after add-account reads ClientProfile with an explicit select (a missing column cannot 500 it)', async (t) => {
  process.env.JWT_SECRET = 'x';
  const user: any = { id: 'user-1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], firstName: 'A', lastName: 'B', avatarUrl: null, profileCompletionPercent: 1, currentLevel: 'L', currentPoints: 1, pointsToNextLevel: 9 };
  let clientSelect: any = null;
  t.mock.module('../config/db', { namedExports: { prisma: { user: {
    findUnique: async (args: any) => {
      if (args?.select?.clientProfile) {
        clientSelect = args.select.clientProfile;
        if (clientSelect === true) throw new Error('The column `client_profiles.paypalPayoutEmail` does not exist in the current database.');
        return { clientProfile: { firstName: 'Client', lastName: 'Persona', avatarUrl: null, completionPercentage: 55, currentLevel: 'L2', currentPoints: 3, pointsToNextLevel: 7 } };
      }
      return user;
    },
    update: async () => user,
  }, accountAuditLog: { create: async () => ({}) } } } });
  const { accountManagementService: svc } = await import(`./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const r = await svc.switchActiveRole('user-1', 'CLIENT');
  assert.equal(r.user.activeRole, 'CLIENT');
  assert.equal(r.user.firstName, 'Client');
  assert.ok(clientSelect && clientSelect !== true && clientSelect.select && !('paypalPayoutEmail' in clientSelect.select));
});

// H1 (role sync): the switch is idempotent — switching to the role that is ALREADY active still returns a fresh token + user carrying that role (a stale tab re-synchronises);
// a role the account does not hold is still refused (400), never auto-granted.
test('H1: switching to the already-active role is idempotent (fresh token + user); an unheld role is refused with 400', async (t) => {
  process.env.JWT_SECRET = 'x';
  const user: any = { id: 'user-1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'PROVIDER', firstName: 'A', lastName: 'B', avatarUrl: null, profileCompletionPercent: 1 };
  const updates: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: { user: {
    findUnique: async (args: any) => (args?.select ? { providerProfile: null, gamification: null } : user),
    update: async (a: any) => { updates.push(a.data); return { ...user, ...a.data }; },
  }, accountAuditLog: { create: async () => ({}) } } } });
  const { accountManagementService: svc } = await import(`./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const a = await svc.switchActiveRole('user-1', 'PROVIDER');
  const b = await svc.switchActiveRole('user-1', 'PROVIDER');
  for (const r of [a, b]) { assert.equal(r.user.activeRole, 'PROVIDER'); assert.ok(typeof r.token === 'string' && r.token.length > 20); }
  assert.deepEqual(updates.map(u => u.activeRole), ['PROVIDER', 'PROVIDER']);
  await assert.rejects(() => svc.switchActiveRole('user-1', 'AFFILIATE'), (e: any) => e.statusCode === 400);
});
