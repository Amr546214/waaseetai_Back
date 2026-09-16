import dotenv from 'dotenv';
import path from 'path';

// Try loading env files
dotenv.config({ path: path.join(__dirname, '../../etc/waseetai/backend-dev.env') });
dotenv.config({ path: '/etc/waseetai/backend-dev.env' });
dotenv.config();

import { prisma } from '../src/config/db';
import { UserRole } from '@prisma/client';
import { getRoleFromAccountType, createMissingRoleProfiles } from '../src/services/account-management.service';

/**
 * Backfill script for Phase 2 of the multi-role/account-profile fix.
 *
 * Target rule: for any user, every role they own should have a matching
 * profile row —
 *   roles includes CLIENT    => ClientProfile exists
 *   roles includes PROVIDER  => ProviderProfile exists
 *   roles includes AFFILIATE => AffiliateProfile exists
 *
 * "Owns" is computed the same way the rest of the app already computes it
 * (self-healing in getAvailableAccountTypes, addAccountType, switchActiveRole):
 * the primary role implied by accountType, merged with whatever is already in
 * the `roles` column. This catches accounts created before role-tracking
 * existed, where `roles` may still be empty/stale relative to accountType.
 *
 * This script ONLY reads the User row (id/firstName/lastName/accountType/
 * roles) to decide what's missing, and ONLY creates missing profile-table
 * rows via the shared createMissingRoleProfiles() helper. It never writes to
 * the User row itself (no roles/activeRole/password/email/wallet/payment
 * changes) and never deletes anything.
 *
 * Dry run (no writes, just prints what would be created):
 *   BACKFILL_DRY_RUN=true npm run backfill:role-profiles
 *
 * Real run:
 *   npm run backfill:role-profiles
 */

const DRY_RUN = process.env.BACKFILL_DRY_RUN === 'true';

async function main() {
  console.log(`\n🔧 Role-profile backfill starting${DRY_RUN ? ' (DRY RUN — no database writes will be made)' : ''}...\n`);

  const users = await prisma.user.findMany({
    select: {
      id: true,
      firstName: true,
      lastName: true,
      accountType: true,
      roles: true,
      clientProfile: { select: { id: true } },
      providerProfile: { select: { id: true } },
      affiliateProfile: { select: { id: true } }
    }
  });

  let usersScanned = 0;
  let clientProfilesCreated = 0;
  let providerProfilesCreated = 0;
  let affiliateProfilesCreated = 0;
  let skippedExisting = 0;

  for (const user of users) {
    usersScanned++;

    // Effective roles = primary role from accountType, merged with the
    // roles[] column — same defensive merge used everywhere else in the app.
    const primaryRole = getRoleFromAccountType(user.accountType);
    const effectiveRoles = Array.from(new Set([primaryRole, ...(user.roles || [])]));

    const needsClient = effectiveRoles.includes(UserRole.CLIENT) && !user.clientProfile;
    const needsProvider = effectiveRoles.includes(UserRole.PROVIDER) && !user.providerProfile;
    const needsAffiliate = effectiveRoles.includes(UserRole.AFFILIATE) && !user.affiliateProfile;

    if (!needsClient && !needsProvider && !needsAffiliate) {
      skippedExisting++;
      continue;
    }

    if (DRY_RUN) {
      const missing = [
        needsClient ? 'ClientProfile' : null,
        needsProvider ? 'ProviderProfile' : null,
        needsAffiliate ? 'AffiliateProfile' : null
      ].filter(Boolean).join(', ');
      console.log(`[DRY RUN] User ${user.id} (${user.firstName} ${user.lastName}) is missing: ${missing}`);
      if (needsClient) clientProfilesCreated++;
      if (needsProvider) providerProfilesCreated++;
      if (needsAffiliate) affiliateProfilesCreated++;
      continue;
    }

    const result = await createMissingRoleProfiles(prisma, user.id, effectiveRoles, {
      firstName: user.firstName,
      lastName: user.lastName
    });

    if (result.clientCreated) {
      clientProfilesCreated++;
      console.log(`✅ Created ClientProfile for user ${user.id} (${user.firstName} ${user.lastName})`);
    }
    if (result.providerCreated) {
      providerProfilesCreated++;
      console.log(`✅ Created ProviderProfile for user ${user.id} (${user.firstName} ${user.lastName})`);
    }
    if (result.affiliateCreated) {
      affiliateProfilesCreated++;
      console.log(`✅ Created AffiliateProfile for user ${user.id} (${user.firstName} ${user.lastName})`);
    }
  }

  console.log(`\n${DRY_RUN ? '📋 Dry-run summary' : '📊 Backfill summary'}`);
  console.table({
    'Users scanned': usersScanned,
    'Client profiles created': clientProfilesCreated,
    'Provider profiles created': providerProfilesCreated,
    'Affiliate profiles created': affiliateProfilesCreated,
    'Users with all profiles already present': skippedExisting
  });

  if (DRY_RUN) {
    console.log('\nℹ️  Dry run only — no database writes were made. Re-run without BACKFILL_DRY_RUN=true to apply.');
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('❌ Fatal error running role-profile backfill:', error);
  await prisma.$disconnect();
  process.exit(1);
});
