import { DisputeStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { FINANCIAL_OUTCOMES, FINANCIAL_OUTCOME_LABELS_AR } from '../utils/dispute-resolution';

/**
 * "Closed by a dispute settlement" is a different end state from "completed by delivery approval". It is DERIVED from the dispute that was RESOLVED with a FINANCIAL
 * outcome (an admin moved the held escrow): nothing is stored, no row is rewritten, so the deliveries, the wallet rows, the audit log and every historical status stay
 * exactly as they were. A TEXT closure moves no money and never makes a project "settled".
 */
export const SETTLED_LABEL_AR = 'أُغلق بتسوية نزاع';
export const SETTLED_STAGE_LABEL_AR = 'أُغلقت بالتسوية';
export const SETTLED_NO_RATING_AR = 'أُغلق المشروع بتسوية نزاع، ولا يتاح تقييمه';

export type AdminSettlement = { settled: true; disputeId: string; outcome: string; outcomeLabel: string; settledAt: Date | null } | { settled: false };

type DisputeReader = { dispute: { findFirst: (args: any) => Promise<{ id: string; resolution: string | null; resolvedAt: Date | null } | null> } };

/** The settlement of a project (by project id and/or the legacy request id), or { settled: false }. */
export async function adminSettlementFor(keys: { projectId?: string | null; requestId?: string | null }, db: DisputeReader = prisma as unknown as DisputeReader): Promise<AdminSettlement> {
  const or: Array<Record<string, string>> = [];
  if (keys.projectId) or.push({ projectId: keys.projectId });
  if (keys.requestId) or.push({ requestId: keys.requestId });
  if (!or.length) return { settled: false };
  const d = await db.dispute.findFirst({ where: { OR: or, status: DisputeStatus.RESOLVED, resolution: { in: FINANCIAL_OUTCOMES as string[] } }, orderBy: { resolvedAt: 'desc' }, select: { id: true, resolution: true, resolvedAt: true } });
  if (!d) return { settled: false };
  const outcome = String(d.resolution);
  return { settled: true, disputeId: d.id, outcome, outcomeLabel: (FINANCIAL_OUTCOME_LABELS_AR as Record<string, string>)[outcome] ?? outcome, settledAt: d.resolvedAt };
}

/** Stage statuses a settlement leaves unreleased: they are DISPLAYED as closed by the settlement, never turned into approved ones. */
export const STAGE_STATUSES_CLOSED_BY_SETTLEMENT = ['PENDING', 'IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED'];
