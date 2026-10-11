import { levelDef, MIN_LEVEL } from '../config/levels.config';

// Fee policy v2 for ESCROWS created after the cut-over (migration 20261011130000):
//  - the client funds exactly the contract price (no escrow-lock fee);
//  - the provider's platform commission is taken when each stage is RELEASED, at the rate snapshotted when the escrow was locked
//    (the provider's level at that moment, from config/levels.config.ts), so a later level change never alters an existing contract;
//  - the provider receives the net, the platform keeps the commission (Escrow.platformCommissionAmount).
// An escrow with feePolicyVersion NULL is LEGACY: funded with the old 13% charge, released gross, never recalculated.
export const ESCROW_FEE_POLICY_V2 = 2;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface EscrowSnapshotFields {
  feePolicyVersion: number;
  providerCommissionRateSnapshot: number;
  providerCommissionLevelSnapshot: number;
  providerCommissionSnapshotAt: Date;
}

/** The snapshot written on a NEW escrow: the provider's current level and that level's commission. A missing / invalid level reads as level 1. */
export function buildEscrowSnapshot(providerLevelIndex: number | null | undefined, now: Date = new Date()): EscrowSnapshotFields {
  const level = Number.isInteger(providerLevelIndex) ? (providerLevelIndex as number) : MIN_LEVEL;
  const def = levelDef('PROVIDER', level);
  return { feePolicyVersion: ESCROW_FEE_POLICY_V2, providerCommissionRateSnapshot: def.percent, providerCommissionLevelSnapshot: def.level, providerCommissionSnapshotAt: now };
}

/** Commission on a cumulative gross released amount. */
export const commissionOn = (grossReleased: number, ratePercent: number): number => round2((grossReleased * ratePercent) / 100);

export interface ReleaseSplit {
  /** gross of this release (the stage value) */
  gross: number;
  /** the platform's commission on this release */
  commission: number;
  /** what the provider receives for this release */
  net: number;
  /** cumulative values after this release (what the escrow row stores) */
  grossReleasedAfter: number;
  commissionTotalAfter: number;
  netReleasedAfter: number;
}

/**
 * Splits one release. The commission is computed on the CUMULATIVE gross (round2(total × rate)) and the stage takes the difference, so the total
 * over the whole contract is exactly round2(price × rate) whatever the stage order or rounding, and the last stage absorbs any cent of drift.
 */
export function splitRelease(args: { grossReleasedBefore: number; commissionTotalBefore: number; grossReleasedAfter: number; ratePercent: number }): ReleaseSplit {
  const grossReleasedAfter = round2(args.grossReleasedAfter);
  const commissionTotalAfter = commissionOn(grossReleasedAfter, args.ratePercent);
  const gross = round2(grossReleasedAfter - args.grossReleasedBefore);
  const commission = round2(commissionTotalAfter - args.commissionTotalBefore);
  return { gross, commission, net: round2(gross - commission), grossReleasedAfter, commissionTotalAfter, netReleasedAfter: round2(grossReleasedAfter - commissionTotalAfter) };
}

/** A v2 escrow carries its snapshot; anything else is legacy. */
export const isV2Escrow = (e: { feePolicyVersion?: number | null } | null | undefined): boolean => e?.feePolicyVersion === ESCROW_FEE_POLICY_V2;

/** What the provider can count on from an escrow: the net released for v2, the gross released for legacy. */
export function providerReleased(e: { feePolicyVersion?: number | null; releasedAmount: number; providerNetReleasedAmount?: number | null }): number {
  return isV2Escrow(e) ? (e.providerNetReleasedAmount ?? 0) : e.releasedAmount;
}

/** The provider's total net entitlement of a v2 escrow once everything is released: price − round2(price × rate). */
export function providerNetEntitlement(price: number, ratePercent: number): number {
  return round2(price - commissionOn(price, ratePercent));
}
