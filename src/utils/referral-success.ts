import { CommissionStatus, CommissionType, Prisma, ReferralStatus } from '@prisma/client';

/**
 * Owner definition (2026-10-15): a referral is SUCCESSFUL when it produced its first due (APPROVED, or later PAID) commission from a REAL operation:
 * a stage release of the referred client's project (type STAGE_RELEASE with a sourceStageId). A seeded / manual ledger row has no sourceStageId and never counts;
 * a repeated stage cannot count twice (one row per stage by the unique index, and a referral is counted ONCE however many commissions it has).
 *
 * The status, the "successful referrals" counter, the pending counter and the conversion rates are all derived from this one rule, so they cannot disagree.
 */
export const REAL_COMMISSION_STATUSES: CommissionStatus[] = [CommissionStatus.APPROVED, CommissionStatus.PAID];

export const realCommissionWhere = (affiliateId: string): Prisma.CommissionLogWhereInput => ({
  affiliateId,
  type: CommissionType.STAGE_RELEASE,
  status: { in: REAL_COMMISSION_STATUSES },
  sourceStageId: { not: null },
  referralId: { not: null }
});

type CommissionReader = { commissionLog: { groupBy: (args: any) => Promise<Array<{ referralId: string | null }>> } };

/** The ids of this affiliate's referrals that are successful by the definition above. */
export async function successfulReferralIds(db: CommissionReader, affiliateId: string): Promise<Set<string>> {
  const rows = await db.commissionLog.groupBy({ by: ['referralId'], where: realCommissionWhere(affiliateId) });
  return new Set(rows.map(r => r.referralId).filter((id): id is string => !!id));
}

/** The status shown for a referral: CONVERTED when it is successful (whatever the stored value says), otherwise the stored one. */
export const effectiveReferralStatus = (stored: ReferralStatus | string, successful: boolean): ReferralStatus | string => (successful ? ReferralStatus.CONVERTED : stored);

/** A commission row (already loaded) that proves success: a real stage release that is due. */
export const isRealDueCommission = (c: { type?: string | null; sourceStageId?: string | null; status?: string | null }): boolean =>
  c.type === CommissionType.STAGE_RELEASE && !!c.sourceStageId && (c.status === CommissionStatus.APPROVED || c.status === CommissionStatus.PAID);
