/**
 * One-off, REVIEWABLE catch-up of stage-release commissions that the engine did not write because it was restricted (dev allowlist) when the stage was approved.
 *
 * It never writes a commission itself and never touches a balance: for every stage that was really approved after the referral existed, it calls the SAME engine
 * hook that the approval path calls (createCommissionsForStageReleaseEvent) inside its own transaction, so the rules (flag, client-only, percentage by level, gross
 * stage amount, USD, APPROVED, unique key, CONVERTED flip) are exactly the live ones. Balances and counters are derived from the commission rows, as everywhere else.
 *
 * Default is a DRY RUN (reads only, prints the statement). `--apply` writes, and only when the plan matches `--expect-count` and `--expect-total` (so what is applied is
 * exactly what was reviewed). Re-running is safe: a stage that already has its commission is reported as ALREADY_COMMISSIONED and never inserted again.
 *
 * Exclusions: `--exclude-project=<id>` (repeatable) and stages that had an OPEN/UNDER_REVIEW dispute AT THE MOMENT they were approved (the engine's own dispute rule,
 * evaluated at release time). No notifications are sent for historical credits.
 *
 *   node dist/scripts/replay-stage-release-commissions.js [--exclude-project=ID ...] [--json=/path/statement.json]
 *   node dist/scripts/replay-stage-release-commissions.js --apply --expect-count=7 --expect-total=0.95 [--exclude-project=ID ...]
 */
import { writeFileSync } from 'node:fs';
import { CommissionType, ProjectStageStatus, type PrismaClient } from '@prisma/client';
import { calculateAffiliateCommission, createCommissionsForStageReleaseEvent } from '../services/affiliate-commission.service';
import { isAffiliateCommissionEngineEnabled } from '../utils/affiliate-commission-engine.util';
import { prisma } from '../config/db';

export type ReplayStatus = 'ELIGIBLE' | 'ALREADY_COMMISSIONED' | 'EXCLUDED_PROJECT' | 'DISPUTE_OPEN_AT_RELEASE' | 'SELF_REFERRAL';

export interface ReplayRow {
  status: ReplayStatus;
  affiliateId: string;
  affiliateUserId: string;
  affiliateLevel: number;
  referralId: string;
  referredUserId: string;
  contractId: string;
  projectId: string;
  stageId: string;
  stepOrder: number;
  grossAmount: number;
  approvedAt: string;
  appliedPercentage: number;
  expectedCommission: number;
}

export interface ReplayOptions {
  excludeProjectIds?: string[];
}

type Db = Pick<PrismaClient, 'referral' | 'contract' | 'dispute' | 'commissionLog'>;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Reads only. One row per (referral, approved stage after the referral existed), classified. */
export async function planStageReleaseCommissions(db: Db, opts: ReplayOptions = {}): Promise<ReplayRow[]> {
  const excluded = new Set(opts.excludeProjectIds ?? []);
  const referrals = await db.referral.findMany({
    select: { id: true, referredUserId: true, createdAt: true, affiliate: { select: { id: true, level: true, userId: true } } },
    orderBy: { createdAt: 'asc' }
  });
  const rows: ReplayRow[] = [];
  for (const referral of referrals) {
    const contracts = await db.contract.findMany({
      where: { clientId: referral.referredUserId },
      select: {
        id: true, projectId: true,
        stages: {
          where: { status: ProjectStageStatus.APPROVED, approvedAt: { gte: referral.createdAt } },
          select: { id: true, stepOrder: true, amount: true, approvedAt: true },
          orderBy: { stepOrder: 'asc' }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
    for (const contract of contracts) {
      for (const stage of contract.stages) {
        if (!stage.approvedAt) continue;
        const calc = calculateAffiliateCommission(referral.affiliate.level, stage.amount);
        const base: Omit<ReplayRow, 'status'> = {
          affiliateId: referral.affiliate.id, affiliateUserId: referral.affiliate.userId, affiliateLevel: referral.affiliate.level,
          referralId: referral.id, referredUserId: referral.referredUserId, contractId: contract.id, projectId: contract.projectId,
          stageId: stage.id, stepOrder: stage.stepOrder, grossAmount: stage.amount, approvedAt: stage.approvedAt.toISOString(),
          appliedPercentage: calc.percentage, expectedCommission: calc.amount
        };
        let status: ReplayStatus = 'ELIGIBLE';
        if (referral.affiliate.userId === referral.referredUserId) status = 'SELF_REFERRAL';
        else if (excluded.has(contract.projectId)) status = 'EXCLUDED_PROJECT';
        else {
          const existing = await db.commissionLog.count({ where: { affiliateId: referral.affiliate.id, referralId: referral.id, type: CommissionType.STAGE_RELEASE, sourceStageId: stage.id } });
          if (existing > 0) status = 'ALREADY_COMMISSIONED';
          else {
            // the engine's dispute rule, evaluated at the moment the stage was approved: a dispute opened before that moment and not resolved yet
            const openAtRelease = await db.dispute.count({
              where: { projectId: contract.projectId, createdAt: { lte: stage.approvedAt }, OR: [{ resolvedAt: null }, { resolvedAt: { gt: stage.approvedAt } }] }
            });
            if (openAtRelease > 0) status = 'DISPUTE_OPEN_AT_RELEASE';
          }
        }
        rows.push({ status, ...base });
      }
    }
  }
  return rows;
}

export interface ReplayApplyResult { inserted: number; skipped: number; total: number; mismatches: string[] }

/** Writes through the real engine, one transaction per stage. Aborts BEFORE writing anything if the plan differs from what was reviewed. */
export async function applyStageReleaseCommissions(
  client: PrismaClient,
  plan: ReplayRow[],
  expect: { count: number; total: number }
): Promise<ReplayApplyResult> {
  const eligible = plan.filter(r => r.status === 'ELIGIBLE');
  const total = r2(eligible.reduce((s, r) => s + r.expectedCommission, 0));
  if (eligible.length !== expect.count || r2(expect.total) !== total) {
    throw new Error(`plan mismatch: ${eligible.length} eligible / ${total} total vs expected ${expect.count} / ${r2(expect.total)}; nothing was written`);
  }
  if (!isAffiliateCommissionEngineEnabled()) throw new Error('AFFILIATE_COMMISSION_ENGINE_ENABLED is not "true": the engine would write nothing; nothing was written');
  const res: ReplayApplyResult = { inserted: 0, skipped: 0, total: 0, mismatches: [] };
  for (const row of eligible) {
    await client.$transaction(async tx => {
      const stage = await tx.projectStage.findUnique({ where: { id: row.stageId }, select: { status: true, amount: true } });
      if (!stage || stage.status !== ProjectStageStatus.APPROVED || stage.amount !== row.grossAmount) { res.skipped++; res.mismatches.push(`${row.stageId}: stage changed since the plan`); return; }
      const notices = await createCommissionsForStageReleaseEvent(tx, {
        contract: { id: row.contractId, projectId: row.projectId, clientId: row.referredUserId, providerId: '' },
        stageId: row.stageId,
        releasedAmount: row.grossAmount
      });
      const mine = notices.filter(n => n.affiliateUserId === row.affiliateUserId);
      if (mine.length === 1) {
        res.inserted++; res.total = r2(res.total + mine[0].amount);
        if (mine[0].amount !== row.expectedCommission) res.mismatches.push(`${row.stageId}: wrote ${mine[0].amount}, expected ${row.expectedCommission}`);
      } else { res.skipped++; }
    });
  }
  return res;
}

function arg(name: string): string[] {
  return process.argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const plan = await planStageReleaseCommissions(prisma, { excludeProjectIds: arg('exclude-project') });
  const eligible = plan.filter(r => r.status === 'ELIGIBLE');
  const eligibleTotal = r2(eligible.reduce((s, r) => s + r.expectedCommission, 0));
  const counts: Record<string, number> = {};
  for (const r of plan) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const byAffiliate: Record<string, { stages: number; gross: number; commission: number }> = {};
  for (const r of eligible) { const a = (byAffiliate[r.affiliateId] ??= { stages: 0, gross: 0, commission: 0 }); a.stages++; a.gross = r2(a.gross + r.grossAmount); a.commission = r2(a.commission + r.expectedCommission); }
  const out = { mode: apply ? 'APPLY' : 'DRY_RUN', engineEnabled: isAffiliateCommissionEngineEnabled(), counts, eligibleTotal, byAffiliate, rows: plan };
  const jsonPath = arg('json')[0];
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, rows: undefined }, null, 2));
  for (const r of plan) console.log(`${r.status.padEnd(24)} aff=${r.affiliateId.slice(0, 8)} ref=${r.referralId.slice(0, 8)} ctr=${r.contractId.slice(0, 8)} stage=${r.stageId.slice(0, 8)}#${r.stepOrder} gross=${r.grossAmount} pct=${r.appliedPercentage} commission=${r.expectedCommission} approved=${r.approvedAt}`);
  if (apply) {
    const count = Number(arg('expect-count')[0]); const total = Number(arg('expect-total')[0]);
    if (!Number.isFinite(count) || !Number.isFinite(total)) throw new Error('--apply needs --expect-count and --expect-total (what was reviewed in the dry run)');
    const result = await applyStageReleaseCommissions(prisma, plan, { count, total });
    console.log('APPLIED', JSON.stringify(result));
    if (result.mismatches.length) process.exitCode = 2;
  }
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : err); process.exit(1); });
}
