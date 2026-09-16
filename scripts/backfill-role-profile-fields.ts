import dotenv from 'dotenv';
import path from 'path';

// Try loading env files
dotenv.config({ path: path.join(__dirname, '../../etc/waseetai/backend-dev.env') });
dotenv.config({ path: '/etc/waseetai/backend-dev.env' });
dotenv.config();

import { prisma } from '../src/config/db';
import { UserRole } from '@prisma/client';
import { getRoleFromAccountType } from '../src/services/account-management.service';

/**
 * Backfill script for Phase 3B of the multi-role/account-profile fix.
 *
 * Phase 2 already guarantees every owned role has its profile row
 * (ClientProfile/ProviderProfile/AffiliateProfile). Phase 3A additively added
 * display/progression columns to those three tables. This script populates
 * ONLY those new columns, independently per owned role, and NEVER creates a
 * profile row itself (a missing row here is reported as SKIPPED — re-run the
 * Phase 2 backfill first if that happens).
 *
 * What this script writes (only when the target field is currently
 * null/unset — never overwrites an already-set, role-specific value):
 *   - ClientProfile.firstName/lastName/avatarUrl   <- copied from User, once
 *   - ClientProfile.currentLevel                   <- defensive default-fill only
 *   - ClientProfile.pointsToNextLevel               <- defensive default-fill only
 *   - ClientProfile.completionPercentage           <- computed via a verbatim
 *       port of profile.service.ts's existing CLIENT scoring formula (see
 *       computeClientCompletionScore below) — NOT a new formula, and only
 *       written while the column is still at its untouched default (0)
 *   - ProviderProfile.firstName/lastName/avatarUrl  <- copied from User, once
 *   - AffiliateProfile.firstName/lastName/avatarUrl <- copied from User, once
 *     (AffiliateProfile.avatarUrl already existed before Phase 3A — same
 *     preserve-if-set/copy-if-null rule applies to it as every other field)
 *
 * What this script NEVER writes, under any circumstance:
 *   - Any User column (firstName/lastName/avatarUrl/currentLevel/currentPoints/
 *     pointsToNextLevel/profileCompletionPercent all stay exactly as they are —
 *     they remain the compatibility fallback until Phase 3C/3D)
 *   - ProviderProfile.completionPercentage, or any provider level/points field
 *     (ProviderGamification.points/currentLevelIndex, PointTransaction) — these
 *     are only ever READ here, for a three-way consistency report, per the
 *     explicit instruction not to create a second provider points source of
 *     truth or silently resolve a discrepancy
 *   - AffiliateProfile.currentLevel or .completionPercentage — both already
 *     exist pre-Phase-3A and are left exactly as-is
 *   - No ClientProfile.currentPoints write, ever — it stays at its schema
 *     default (0); CLIENT point-award business logic is explicitly out of
 *     scope for Phase 3B
 *   - wallet/order/cart/withdrawal/transaction/rating/tier/AI-risk/auth data
 *   - No deletes, no destructive statements of any kind
 *
 * Idempotent: every write is gated on "the target field is still at its
 * untouched default/null", so re-running after a successful real backfill
 * finds nothing left to do (UNCHANGED for everything) and writes nothing.
 *
 * Dry run (no writes, just prints what would change):
 *   BACKFILL_DRY_RUN=true npm run backfill:role-profile-fields
 *
 * Real run:
 *   npm run backfill:role-profile-fields
 */

const DRY_RUN = process.env.BACKFILL_DRY_RUN === 'true';

const CLIENT_DEFAULT_LEVEL = 'مستكشف - المستوى 1';
const CLIENT_DEFAULT_POINTS_TO_NEXT = 100;

type FieldOutcome = 'WOULD_UPDATE' | 'UPDATED' | 'UNCHANGED';

/**
 * Preserve-if-set / copy-if-null for a single display field. Never overwrites
 * a non-empty existing value — that's treated as an already-independent,
 * deliberately-set role-specific value, per the Phase 3B instructions.
 */
function planFieldCopy(existingValue: string | null | undefined, sourceValue: string | null | undefined): { outcome: FieldOutcome; value?: string } {
  if (existingValue !== null && existingValue !== undefined && existingValue !== '') {
    return { outcome: 'UNCHANGED' }; // already independently set — preserve
  }
  if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
    return { outcome: 'UNCHANGED' }; // nothing to copy either — stays null
  }
  return { outcome: DRY_RUN ? 'WOULD_UPDATE' : 'UPDATED', value: sourceValue };
}

/**
 * Verbatim port of the CLIENT completion-scoring logic in
 * src/services/profile.service.ts's getProfile() (baseFields/metaFields/
 * kycFields/bankingFields weights), applied here read-only against the exact
 * same merged {...User, ...ClientProfile} shape that function already builds
 * for CLIENT accountType users today. This is NOT a new formula — it exists
 * so the proposed ClientProfile.completionPercentage matches exactly what the
 * existing endpoint would already compute for this person, sourced from
 * CLIENT-relevant data. profile.service.ts itself is not touched/imported
 * from (Phase 3B must not change backend read/write behavior yet), so the
 * scoring rules are intentionally duplicated here, verbatim, with this note
 * as a pointer to consolidate into a shared helper in a later phase.
 */
function computeClientCompletionScore(mergedData: Record<string, any>): number {
  let score = 0;

  const baseFields = ['firstName', 'lastName', 'phoneNumber', 'avatarUrl'];
  baseFields.forEach(f => { if (mergedData[f]) score += 7.5; });

  const metaFields = ['bio', 'companyName', 'companySize', 'industry', 'website'];
  metaFields.forEach(f => { if (mergedData[f]) score += 6.0; });

  const kycFields = ['idNumber', 'idExpiryDate'];
  kycFields.forEach(f => { if (mergedData[f]) score += 10.0; });

  const bankingFields = ['ibanNumber', 'bankName', 'accountHolderName'];
  bankingFields.forEach(f => { if (mergedData[f]) score += (20 / 3); });

  return Math.min(100, Math.round(score));
}

/**
 * Confirms the Phase 3A migration's columns actually exist on the database
 * this script is about to run against, before touching anything else. Per
 * the Phase 3B instructions: if the migration hasn't been applied here (or
 * the database can't be reached at all), stop immediately with a clear
 * message instead of crashing mid-scan or guessing.
 */
async function checkPhase3AApplied(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await prisma.clientProfile.findFirst({
      select: { id: true, firstName: true, currentLevel: true, currentPoints: true, pointsToNextLevel: true, completionPercentage: true }
    });
    await prisma.providerProfile.findFirst({ select: { id: true, firstName: true, avatarUrl: true } });
    await prisma.affiliateProfile.findFirst({ select: { id: true, firstName: true } });
    return { ok: true };
  } catch (error: any) {
    if (error?.code === 'P1001') {
      const detail = String(error?.message || '').split('\n').map(l => l.trim()).filter(Boolean)[0] || 'database server unreachable';
      return {
        ok: false,
        reason: `Cannot reach the database (Prisma P1001: ${detail}). Migration status cannot be verified from here, so no scan will run.`
      };
    }
    if (error?.code === 'P2022' || error?.code === 'P2021' || /column .* does not exist/i.test(String(error?.message)) || /table .* does not exist/i.test(String(error?.message))) {
      return {
        ok: false,
        reason: `The Phase 3A columns do not exist on this database yet (Prisma error ${error?.code || 'unknown'}). The Phase 3A migration has not been applied here — apply it first, then re-run this backfill.`
      };
    }
    return { ok: false, reason: `Unexpected error while checking whether Phase 3A is applied: ${error?.message || error}` };
  }
}

async function main() {
  console.log(`\n🔧 Role-profile FIELDS backfill (Phase 3B) starting${DRY_RUN ? ' (DRY RUN — no database writes will be made)' : ''}...\n`);

  const readiness = await checkPhase3AApplied();
  if (!readiness.ok) {
    console.error(`❌ Cannot proceed: ${readiness.reason}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log('✅ Phase 3A columns detected — proceeding with scan.\n');

  const users = await prisma.user.findMany({
    select: {
      id: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      phoneNumber: true,
      accountType: true,
      roles: true,
      currentPoints: true, // read-only, for the provider consistency report
      profileCompletionPercent: true, // read-only, for the dry-run comparison print
      idNumber: true,
      idExpiryDate: true,
      ibanNumber: true,
      bankName: true,
      accountHolderName: true,
      clientProfile: true,
      providerProfile: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, completionPercentage: true } },
      affiliateProfile: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, currentLevel: true, completionPercentage: true } }
    }
  });

  // Totals — named to match the requested dry-run report shape.
  let usersScanned = 0;
  let clientProfilesInspected = 0;
  let providerProfilesInspected = 0;
  let affiliateProfilesInspected = 0;
  let clientDisplayFieldsToInitialize = 0;
  let providerDisplayFieldsToInitialize = 0;
  let affiliateDisplayFieldsToInitialize = 0;
  let clientCompletionValuesProposed = 0;
  let clientPointsPreservedOrDefaulted = 0;
  let providerGamificationConsistent = 0;
  let providerGamificationConflicts = 0;
  let existingIndependentValuesPreserved = 0;
  let conflictsRequiringManualReview = 0;
  let usersRequiringUpdates = 0;
  let usersAlreadyFullyInitialized = 0;

  for (const user of users) {
    usersScanned++;
    const primaryRole = getRoleFromAccountType(user.accountType);
    const effectiveRoles = Array.from(new Set([primaryRole, ...(user.roles || [])]));
    const label = `${user.id} (${user.firstName} ${user.lastName})`;
    let userChanged = false;

    // ---------------------------------------------------------------- CLIENT
    if (effectiveRoles.includes(UserRole.CLIENT)) {
      if (!user.clientProfile) {
        console.log(`[SKIPPED] ${label} owns CLIENT but has no ClientProfile row — this is a Phase 2 gap, re-run the Phase 2 backfill first.`);
      } else {
        clientProfilesInspected++;
        const cp = user.clientProfile;
        const updates: Record<string, any> = {};

        const fnPlan = planFieldCopy(cp.firstName, user.firstName);
        const lnPlan = planFieldCopy(cp.lastName, user.lastName);
        const avPlan = planFieldCopy(cp.avatarUrl, user.avatarUrl);
        if (fnPlan.outcome !== 'UNCHANGED') { updates.firstName = fnPlan.value; clientDisplayFieldsToInitialize++; }
        else if (cp.firstName) existingIndependentValuesPreserved++;
        if (lnPlan.outcome !== 'UNCHANGED') { updates.lastName = lnPlan.value; clientDisplayFieldsToInitialize++; }
        else if (cp.lastName) existingIndependentValuesPreserved++;
        if (avPlan.outcome !== 'UNCHANGED') { updates.avatarUrl = avPlan.value; clientDisplayFieldsToInitialize++; }
        else if (cp.avatarUrl) existingIndependentValuesPreserved++;

        // Defensive default-fill only — normally already set by the migration's
        // ADD COLUMN ... DEFAULT for every pre-existing row.
        if (cp.currentLevel === null || cp.currentLevel === undefined) {
          updates.currentLevel = CLIENT_DEFAULT_LEVEL;
        }
        if (cp.pointsToNextLevel === null || cp.pointsToNextLevel === undefined) {
          updates.pointsToNextLevel = CLIENT_DEFAULT_POINTS_TO_NEXT;
        }

        // currentPoints: NEVER copied from User.currentPoints (provider-earned
        // data, per the audit) and NEVER written here at all — report only.
        if (cp.currentPoints === 0) {
          clientPointsPreservedOrDefaulted++;
        } else {
          clientPointsPreservedOrDefaulted++; // still just reported/preserved, not touched
          console.log(`[UNCHANGED] ${label} ClientProfile.currentPoints is already non-default (${cp.currentPoints}) — preserved, not touched.`);
        }

        // completionPercentage: only computed/written while still at the
        // untouched default (0); otherwise treated as already independently
        // set and preserved.
        const mergedForScore = { ...user, ...cp };
        const proposedCompletion = computeClientCompletionScore(mergedForScore);
        const existingUserPercent = user.profileCompletionPercent;
        const differsFromUser = proposedCompletion !== existingUserPercent;
        console.log(`[INFO] ${label} CLIENT completion — existing User.profileCompletionPercent=${existingUserPercent}, proposed ClientProfile.completionPercentage=${proposedCompletion}${differsFromUser ? ' (differs)' : ' (matches)'}`);
        if (cp.completionPercentage === 0) {
          if (proposedCompletion !== 0) {
            updates.completionPercentage = proposedCompletion;
            clientCompletionValuesProposed++;
          }
        } else {
          existingIndependentValuesPreserved++;
          console.log(`[UNCHANGED] ${label} ClientProfile.completionPercentage is already non-default (${cp.completionPercentage}) — preserved, not touched.`);
        }

        if (Object.keys(updates).length > 0) {
          userChanged = true;
          console.log(`[${DRY_RUN ? 'WOULD_UPDATE' : 'UPDATED'}] ${label} ClientProfile <- ${JSON.stringify(updates)}`);
          if (!DRY_RUN) {
            await prisma.clientProfile.update({ where: { userId: user.id }, data: updates });
          }
        }
      }
    }

    // -------------------------------------------------------------- PROVIDER
    if (effectiveRoles.includes(UserRole.PROVIDER)) {
      if (!user.providerProfile) {
        console.log(`[SKIPPED] ${label} owns PROVIDER but has no ProviderProfile row — this is a Phase 2 gap, re-run the Phase 2 backfill first.`);
      } else {
        providerProfilesInspected++;
        const pp = user.providerProfile;
        const updates: Record<string, any> = {};

        const fnPlan = planFieldCopy(pp.firstName, user.firstName);
        const lnPlan = planFieldCopy(pp.lastName, user.lastName);
        const avPlan = planFieldCopy(pp.avatarUrl, user.avatarUrl);
        if (fnPlan.outcome !== 'UNCHANGED') { updates.firstName = fnPlan.value; providerDisplayFieldsToInitialize++; }
        else if (pp.firstName) existingIndependentValuesPreserved++;
        if (lnPlan.outcome !== 'UNCHANGED') { updates.lastName = lnPlan.value; providerDisplayFieldsToInitialize++; }
        else if (pp.lastName) existingIndependentValuesPreserved++;
        if (avPlan.outcome !== 'UNCHANGED') { updates.avatarUrl = avPlan.value; providerDisplayFieldsToInitialize++; }
        else if (pp.avatarUrl) existingIndependentValuesPreserved++;

        // completionPercentage: read-only report, never written/mirrored here.
        console.log(`[INFO] ${label} PROVIDER ProviderProfile.completionPercentage=${pp.completionPercentage} (preserved, not touched).`);

        // Points/level: NEVER written. Read-only three-way consistency check
        // against the real ledger — per instructions, any discrepancy is
        // reported and left completely untouched, not silently resolved.
        const [gamification, ledgerAgg] = await Promise.all([
          prisma.providerGamification.findUnique({ where: { providerId: user.id } }),
          prisma.pointTransaction.aggregate({ where: { providerId: user.id }, _sum: { amount: true } })
        ]);
        const ledgerSum = ledgerAgg._sum.amount || 0;
        const gamificationPoints = gamification?.points ?? null;
        const userPoints = user.currentPoints;

        if (gamificationPoints === null) {
          console.log(`[INFO] ${label} PROVIDER has no ProviderGamification row yet (lazily created on first gamification view or project completion) — not a conflict. User.currentPoints=${userPoints}, SUM(PointTransaction)=${ledgerSum}.`);
          if (userPoints === ledgerSum) {
            providerGamificationConsistent++;
          } else {
            providerGamificationConflicts++;
            conflictsRequiringManualReview++;
            console.log(`[CONFLICT] ${label} PROVIDER points mismatch (no gamification row): User.currentPoints=${userPoints} vs SUM(PointTransaction)=${ledgerSum}. Left unchanged pending manual review.`);
          }
        } else if (userPoints === gamificationPoints && gamificationPoints === ledgerSum) {
          providerGamificationConsistent++;
        } else {
          providerGamificationConflicts++;
          conflictsRequiringManualReview++;
          console.log(`[CONFLICT] ${label} PROVIDER points mismatch: User.currentPoints=${userPoints}, ProviderGamification.points=${gamificationPoints}, SUM(PointTransaction)=${ledgerSum}. Left unchanged pending manual review.`);
        }

        if (Object.keys(updates).length > 0) {
          userChanged = true;
          console.log(`[${DRY_RUN ? 'WOULD_UPDATE' : 'UPDATED'}] ${label} ProviderProfile <- ${JSON.stringify(updates)}`);
          if (!DRY_RUN) {
            await prisma.providerProfile.update({ where: { userId: user.id }, data: updates });
          }
        }
      }
    }

    // ------------------------------------------------------------- AFFILIATE
    if (effectiveRoles.includes(UserRole.AFFILIATE)) {
      if (!user.affiliateProfile) {
        console.log(`[SKIPPED] ${label} owns AFFILIATE but has no AffiliateProfile row — this is a Phase 2 gap, re-run the Phase 2 backfill first.`);
      } else {
        affiliateProfilesInspected++;
        const ap = user.affiliateProfile;
        const updates: Record<string, any> = {};

        const fnPlan = planFieldCopy(ap.firstName, user.firstName);
        const lnPlan = planFieldCopy(ap.lastName, user.lastName);
        // AffiliateProfile.avatarUrl already existed before Phase 3A — same
        // preserve-if-set/copy-if-null rule applies uniformly; a non-null
        // value here is always already-independent affiliate data and is
        // never overwritten by User.avatarUrl.
        const avPlan = planFieldCopy(ap.avatarUrl, user.avatarUrl);
        if (fnPlan.outcome !== 'UNCHANGED') { updates.firstName = fnPlan.value; affiliateDisplayFieldsToInitialize++; }
        else if (ap.firstName) existingIndependentValuesPreserved++;
        if (lnPlan.outcome !== 'UNCHANGED') { updates.lastName = lnPlan.value; affiliateDisplayFieldsToInitialize++; }
        else if (ap.lastName) existingIndependentValuesPreserved++;
        if (avPlan.outcome !== 'UNCHANGED') { updates.avatarUrl = avPlan.value; affiliateDisplayFieldsToInitialize++; }
        else if (ap.avatarUrl) existingIndependentValuesPreserved++;

        // currentLevel/completionPercentage already existed pre-Phase-3A and
        // are NOT NULL with a schema default — always already populated.
        // Read-only report, never written/mirrored from User here.
        console.log(`[INFO] ${label} AFFILIATE currentLevel="${ap.currentLevel}", completionPercentage=${ap.completionPercentage} (both preserved, not touched). No points concept exists for AFFILIATE in the current schema — N/A.`);
        existingIndependentValuesPreserved += 2; // currentLevel + completionPercentage, always already set

        if (Object.keys(updates).length > 0) {
          userChanged = true;
          console.log(`[${DRY_RUN ? 'WOULD_UPDATE' : 'UPDATED'}] ${label} AffiliateProfile <- ${JSON.stringify(updates)}`);
          if (!DRY_RUN) {
            await prisma.affiliateProfile.update({ where: { userId: user.id }, data: updates });
          }
        }
      }
    }

    if (userChanged) usersRequiringUpdates++;
    else usersAlreadyFullyInitialized++;
  }

  console.log(`\n${DRY_RUN ? '📋 Dry-run summary' : '📊 Backfill summary'}`);
  console.table({
    'Users scanned': usersScanned,
    'Client profiles inspected': clientProfilesInspected,
    'Provider profiles inspected': providerProfilesInspected,
    'Affiliate profiles inspected': affiliateProfilesInspected,
    'Client display fields to initialize': clientDisplayFieldsToInitialize,
    'Provider display fields to initialize': providerDisplayFieldsToInitialize,
    'Affiliate display fields to initialize': affiliateDisplayFieldsToInitialize,
    'Client completion values proposed': clientCompletionValuesProposed,
    'Client points preserved/defaulted': clientPointsPreservedOrDefaulted,
    'Provider gamification consistent': providerGamificationConsistent,
    'Provider gamification conflicts': providerGamificationConflicts,
    'Existing independent values preserved': existingIndependentValuesPreserved,
    'Conflicts requiring manual review': conflictsRequiringManualReview,
    'Users requiring updates': usersRequiringUpdates,
    'Users already fully initialized': usersAlreadyFullyInitialized
  });

  if (conflictsRequiringManualReview > 0) {
    console.log(`\n⚠️  ${conflictsRequiringManualReview} provider points conflict(s) found — left completely unchanged. Review before any future phase touches provider points.`);
  }

  if (DRY_RUN) {
    console.log('\nℹ️  Dry run only — no database writes were made. Re-run without BACKFILL_DRY_RUN=true to apply.');
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('❌ Fatal error running role-profile fields backfill:', error);
  await prisma.$disconnect();
  process.exit(1);
});
