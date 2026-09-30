import { Prisma } from '@prisma/client';

/**
 * Deployment-safety helper (P-LG-012 affiliate commission engine rollout).
 *
 * `AffiliateProfile.level` was added to prisma/schema.prisma for the
 * (currently disabled) commission engine, but its migration
 * (prisma/migrations/20260930100000_add_affiliate_commission_fields) is
 * marked NOT EXECUTED and has not been applied to DEV/LIVE. Any Prisma query
 * against AffiliateProfile that uses the default field selection (no
 * `select`, or a bare `include`/`select: { affiliateProfile: true }`, which
 * does NOT restrict the parent model's own scalars) will ask Postgres for
 * every scalar column, including `level` — and 500 with a "column does not
 * exist" error against a DB that hasn't run the migration yet. This is the
 * same bug class that caused the earlier `provider_profiles.paypalPayoutEmail`
 * DEV outage.
 *
 * This constant is every AffiliateProfile scalar column that exists in the
 * CURRENT (pre-migration) database, explicitly listed, so call sites that
 * need to forward/spread the "full" AffiliateProfile row (preserving an
 * existing API response shape) can do so safely without also requesting the
 * new, not-yet-existing `level` column. Relations (user, marketingChannels,
 * referrals, commissionLogs, channelMetrics, customLinks,
 * profileChangeRequests) are intentionally NOT included here — callers add
 * whichever of those they actually need, with their own explicit nested
 * `select`.
 *
 * Do NOT add `level` to this constant until the migration has actually been
 * applied to the target database.
 */
export const AFFILIATE_PROFILE_SAFE_SCALAR_SELECT = {
  id: true,
  userId: true,
  referralSlug: true,
  currentLevel: true,
  commissionRatePercentage: true,
  notifyOnNewReferral: true,
  sharePerformanceStats: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  bio: true,
  bankName: true,
  accountHolderName: true,
  iban: true,
  swiftCode: true,
  identityVerified: true,
  kycDocumentUrl: true,
  payoutMethod: true,
  minimumPayoutAmount: true,
  completionPercentage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AffiliateProfileSelect;
