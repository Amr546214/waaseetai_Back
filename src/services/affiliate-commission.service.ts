import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger';
import { feePolicyService } from './fee-policy.service';
import { Prisma, CommissionType, CommissionStatus, DisputeStatus } from '@prisma/client';
import type { MarketerCommissionNotice } from './marketer-notifications.service';
import { resolveAffiliateCommissionPercentage } from '../config/affiliate-levels.config';
import { isAffiliateCommissionEngineEnabled, affiliateCommissionAllowedReferralIds } from '../utils/affiliate-commission-engine.util';

// The exact composite unique index this engine relies on for exactly-once
// commission creation — see prisma/schema.prisma's CommissionLog
// @@unique([affiliateId, referralId, type, sourceStageId]) and the
// migration (applied by hand on DEV 2026-10-11; LIVE applied by the team) prisma/migrations/
// 20260930100000_add_affiliate_commission_fields/migration.sql.
const COMMISSION_DEDUP_CONSTRAINT = 'commission_logs_affiliateId_referralId_type_sourceStageId_key';
const COMMISSION_DEDUP_FIELDS = ['affiliateId', 'referralId', 'type', 'sourceStageId'];

/**
 * Same P2002-metadata-extraction approach as cart-checkout.service.ts's
 * extractP2002Candidates() / payout.service.ts's extractConflictCandidates()
 * — duplicated narrowly here (rather than imported) to keep this domain
 * independent, per this codebase's established separation. Pulls every
 * string that could identify the violated constraint/index or column(s)
 * from a P2002's metadata, across both the "standard" Prisma shape
 * (`error.meta.target`) and the driver-adapter shape confirmed elsewhere in
 * this codebase (`error.meta.driverAdapterError.cause`).
 */
function extractP2002Candidates(error: Prisma.PrismaClientKnownRequestError): string[] {
  const candidates: string[] = [];

  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (typeof target === 'string') candidates.push(target);
  else if (Array.isArray(target)) candidates.push(...target.filter((t): t is string => typeof t === 'string'));

  const driverCause = (error.meta as { driverAdapterError?: { cause?: unknown } } | undefined)?.driverAdapterError?.cause;
  if (driverCause && typeof driverCause === 'object') {
    const cause = driverCause as { originalMessage?: unknown; constraint?: { fields?: unknown } };
    if (typeof cause.originalMessage === 'string') {
      const nameMatch = cause.originalMessage.match(/unique constraint "([^"]+)"/);
      if (nameMatch) candidates.push(nameMatch[1]);
    }
    if (cause.constraint && typeof cause.constraint === 'object' && Array.isArray(cause.constraint.fields)) {
      candidates.push(...cause.constraint.fields
        .filter((f): f is string => typeof f === 'string')
        .map(f => f.replace(/^"|"$/g, '')));
    }
  }

  return candidates;
}

/**
 * Narrow classification ONLY: true iff this P2002 specifically violated the
 * CommissionLog exactly-once dedup constraint — the expected signature of a
 * retried/duplicate commission-creation attempt for the SAME
 * affiliate+referral+type+release-event (e.g. a retried transaction, or two
 * concurrent reviewDelivery() calls somehow racing past the stage-transition
 * guard). Any OTHER P2002 (a different constraint, or an unrecognized shape)
 * returns false and is never treated as this race — it propagates
 * unmodified, exactly like the established pattern elsewhere in this
 * codebase, so an unrelated data-integrity conflict is never silently
 * masked as "already processed."
 */
function isDuplicateCommissionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const candidates = extractP2002Candidates(error);
  if (candidates.includes(COMMISSION_DEDUP_CONSTRAINT)) return true;
  // Field-name fallback (some Prisma/driver combinations report the column
  // list instead of/alongside the index name): only treat it as OUR
  // constraint if every one of our dedup fields is present, so an unrelated
  // partial overlap (e.g. a P2002 on affiliateId+status from some other
  // index) is never misclassified.
  return COMMISSION_DEDUP_FIELDS.every(f => candidates.includes(f));
}

/** the day the official workbook ladders (#101) took effect */
const LADDER_FINAL_AT = Date.parse('2026-10-11T00:00:00Z');
export interface AffiliateCommissionCalculation {
  level: number;
  percentage: number;
  amount: number;
}

/**
 * Pure calculation — no DB access — so it is directly unit-testable in
 * isolation regardless of the AFFILIATE_COMMISSION_ENGINE_ENABLED flag.
 * Rounds to 2 decimal places (currency-safe rounding), matching how money
 * amounts are already handled elsewhere in this codebase.
 */
export function calculateAffiliateCommission(level: number, baseAmount: number, ladder?: readonly number[]): AffiliateCommissionCalculation {
  // `ladder` = the marketer commission table of the fee policy the contract's escrow was locked under; without one, today's built-in table
  const valid = Number.isInteger(level) && level >= 1 && level <= (ladder?.length ?? 15);
  const percentage = ladder ? ladder[valid ? level - 1 : 0] : resolveAffiliateCommissionPercentage(level);
  const amount = Math.round(baseAmount * (percentage / 100) * 100) / 100;
  return { level, percentage, amount };
}

export interface StageReleaseCommissionContext {
  contract: { id: string; projectId: string; clientId: string; providerId: string };
  stageId: string;
  releasedAmount: number;
}

/**
 * The P-LG-012 commission-creation hook. Called ADDITIVELY, from INSIDE the
 * same prisma.$transaction as the escrow-release event it is based on (see
 * project-progress.service.ts::reviewDelivery()'s approve path, at both the
 * intermediate-stage and final-stage release points) — a commission is
 * created atomically with the fund release it's based on, never separately,
 * never outside that transaction.
 *
 * Behavior when AFFILIATE_COMMISSION_ENGINE_ENABLED is unset/false (the
 * default): returns immediately after the flag check below — a complete
 * no-op, zero reads, zero writes, zero side effects, identical behavior to
 * before this function existed. See affiliate-commission-engine.util.ts for
 * the flag convention.
 *
 * Dispute safety: if the project currently has an OPEN or UNDER_REVIEW
 * Dispute, this skips commission creation entirely for this release event.
 * This only prevents NEW commissions on an already-disputed transaction —
 * it does NOT reverse/claw back a commission already created before a LATER
 * dispute/refund. That reversal/clawback mechanism is explicitly NOT built
 * here; it is flagged as an unresolved design question (see the final audit
 * report).
 *
 * Referred-role handling (owner decision 2026-10-11): ONLY the referred CLIENT
 * of the contract earns a commission. A referred PROVIDER earns nothing at this
 * stage — contract.providerId is deliberately never looked up. The commission is
 * a platform liability: it is not deducted from the client's price or the
 * provider's net, and the base is the gross stage.amount.
 */
export async function createCommissionsForStageReleaseEvent(
  tx: Prisma.TransactionClient,
  { contract, stageId, releasedAmount }: StageReleaseCommissionContext
): Promise<MarketerCommissionNotice[]> {
  // The commissions written by this call, so the caller can tell each marketer AFTER its transaction has committed (never from inside it).
  const created: MarketerCommissionNotice[] = [];
  if (!isAffiliateCommissionEngineEnabled()) return created;

  const activeDispute = await tx.dispute.findFirst({
    where: {
      projectId: contract.projectId,
      status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] }
    },
    select: { id: true }
  });
  if (activeDispute) return created;

  // the marketer table of the policy version the contract's escrow was locked under (a later policy version never changes an existing contract's marketer rates)
  const escrowPolicy = await tx.escrow.findFirst({ where: { projectId: contract.projectId }, select: { feePolicyId: true, createdAt: true } });
  // An escrow without a stored policy id is read as the baseline (v1 = the ladder in force since the official workbooks, 2026-10-11). One locked BEFORE that date was created under an older ladder
  // that was never stored on the row, so its marketer terms cannot be proven: say so (the baseline is still what was always applied; nothing is invented or recomputed).
  if (escrowPolicy && !escrowPolicy.feePolicyId && escrowPolicy.createdAt && escrowPolicy.createdAt.getTime() < LADDER_FINAL_AT) logger.warn(`[affiliate] project ${contract.projectId}: escrow predates the final marketer ladder and stores no policy id; its marketer terms are not provable, the baseline ladder is applied`);
  const ladder = (await feePolicyService.byId(escrowPolicy?.feePolicyId)).payload.marketerCommissionByLevel;
  const referrals = await tx.referral.findMany({
    where: { referredUserId: contract.clientId },
    include: { affiliate: { select: { id: true, level: true, userId: true } } }
  });

  // DEV-only restriction (env allowlist of Referral ids): referrals outside it are skipped exactly as if the engine were off for them. Unset = no restriction.
  const allowed = affiliateCommissionAllowedReferralIds();
  for (const referral of referrals) {
    if (allowed && !allowed.has(referral.id)) continue;
    // Client-only: never pay on any referral that is not the contract's client (defence in depth beyond the query above).
    if (referral.referredUserId !== contract.clientId) continue;
    // Defense-in-depth self-referral guard, mirroring the primary guard
    // applied at attribution time in auth.service.ts's resolveReferralAttribution().
    // Structurally can't happen via normal signup (the referred user has no
    // id yet when picking a code), but guarded here too since this function
    // has its own independent DB read of the Referral/AffiliateProfile rows.
    if (referral.affiliate.userId === referral.referredUserId) continue;

    const { percentage, amount, level } = calculateAffiliateCommission(referral.affiliate.level, releasedAmount, ladder);

    // Exactly-once WITHOUT aborting the caller's transaction: a duplicate insert that raises a unique violation inside a PostgreSQL transaction puts the whole
    // transaction into the aborted state (25P02) even when the error is caught, so the rest of the stage approval would fail. INSERT ... ON CONFLICT DO NOTHING
    // (createMany + skipDuplicates) on the same unique index reports "already processed" as count 0 and leaves the transaction healthy.
    {
      const commissionId = randomUUID();
      const { count } = await tx.commissionLog.createMany({
        skipDuplicates: true,
        data: [{
          id: commissionId,
          affiliateId: referral.affiliate.id,
          referralId: referral.id,
          referredUserId: referral.referredUserId,
          type: CommissionType.STAGE_RELEASE,
          amount,
          // Explicit per-row currency (USD), never the database default.
          currency: 'USD',
          // The eligibility check for this release event (stage actually
          // released, project not currently disputed) has already run
          // synchronously above — there is no separate manual-approval step
          // for a STAGE_RELEASE commission, so it is recorded as
          // immediately APPROVED (available for withdrawal, subject to the
          // existing 300-minimum floor), not PENDING.
          status: CommissionStatus.APPROVED,
          sourceProjectId: contract.projectId,
          sourceStageId: stageId,
          baseAmount: releasedAmount,
          appliedPercentage: percentage,
          level
        }]
      });
      // 0 = this (affiliate, referral, type, stage) was already processed: a replay or a concurrent twin. Nothing to add, nothing to notify, and the transaction is intact.
      if (count === 0) continue;
      created.push({ affiliateUserId: referral.affiliate.userId, commissionId: commissionId, amount, currency: 'USD' });
      // The first real due commission makes the referral SUCCESSFUL (owner definition): forward-only, in the same transaction (the counters derive from the commissions too).
      await tx.referral.updateMany({ where: { id: referral.id, status: { not: 'CONVERTED' } }, data: { status: 'CONVERTED' } });
    }
  }
  return created;
}
