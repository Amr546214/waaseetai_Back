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

/**
 * THE one rule for "settled" as a Prisma filter. Every "completed by delivery" counter uses `deliveryCompletedProject()` / `NOT_SETTLED_PROJECT`
 * instead of re-writing the dispute condition. A project that an admin closed with a financial dispute decision is not a delivery achievement.
 */
export const SETTLED_DISPUTE_WHERE = { status: DisputeStatus.RESOLVED, resolution: { in: FINANCIAL_OUTCOMES as string[] } } as const;
export const NOT_SETTLED_PROJECT = { disputes: { none: SETTLED_DISPUTE_WHERE } } as const;

/** `where` for projects genuinely completed by delivery approval (status COMPLETED and not closed by a settlement). */
export const deliveryCompletedProject = <T extends Record<string, unknown> = {}>(extra?: T) => ({ ...(extra ?? ({} as T)), status: 'COMPLETED' as const, ...NOT_SETTLED_PROJECT });

/** True when a loaded project's disputes (already fetched) contain a financial settlement. For rows loaded with `disputes` included. */
export const hasFinancialSettlement = (disputes: Array<{ status?: string | null; resolution?: string | null }> | null | undefined): boolean =>
  (disputes ?? []).some(d => d.status === DisputeStatus.RESOLVED && (FINANCIAL_OUTCOMES as string[]).includes(String(d.resolution)));

/** Of the given project ids, those that are settled (one query). */
export async function settledProjectIds(ids: string[], db: { dispute: { findMany: (args: any) => Promise<Array<{ projectId: string | null }>> } } = prisma as any): Promise<Set<string>> {
  const clean = Array.from(new Set(ids.filter(Boolean)));
  if (!clean.length) return new Set();
  const rows = await db.dispute.findMany({ where: { projectId: { in: clean }, ...SETTLED_DISPUTE_WHERE }, select: { projectId: true } });
  return new Set(rows.map(r => r.projectId).filter((x): x is string => !!x));
}

/** The status shown to people: a settled COMPLETED project is "closed by settlement", never "completed". */
export const displayProjectStatus = (status: string, settled: boolean): { code: string; label: string | null } =>
  settled && (status === 'COMPLETED' || status === 'DISPUTED') ? { code: 'CLOSED_BY_SETTLEMENT', label: SETTLED_LABEL_AR } : { code: status, label: null };

export const STAGE_CLOSED_BY_SETTLEMENT = 'CLOSED_BY_SETTLEMENT';
/** Derived display status of one stage. Never stored, never "approved". */
export function stageDisplayStatus(stageStatus: string, settled: boolean): { displayStatus: string | null; displayStatusLabel: string | null } {
  if (settled && STAGE_STATUSES_CLOSED_BY_SETTLEMENT.includes(stageStatus)) return { displayStatus: STAGE_CLOSED_BY_SETTLEMENT, displayStatusLabel: SETTLED_STAGE_LABEL_AR };
  return { displayStatus: null, displayStatusLabel: null };
}

export const AMENDMENT_CONTRACT_CLOSED_AR = 'أُغلق العقد، ولم يعد التعديل قابلًا للتطبيق';

export type AdminSettledView = { disputeId: string; outcome: string; label: string };

/** The `adminSettled` field of the read models: null when the project is not settled. */
export const adminSettledView = (s: AdminSettlement): AdminSettledView | null => (s.settled ? { disputeId: s.disputeId, outcome: s.outcome, label: SETTLED_LABEL_AR } : null);

/** Batch version for lists: projectId -> adminSettled (only settled projects are present). */
export async function settlementsByProject(ids: string[], db: { dispute: { findMany: (args: any) => Promise<Array<{ id: string; projectId: string | null; resolution: string | null }>> } } = prisma as any): Promise<Map<string, AdminSettledView>> {
  const clean = Array.from(new Set(ids.filter(Boolean)));
  const out = new Map<string, AdminSettledView>();
  if (!clean.length) return out;
  const rows = await db.dispute.findMany({ where: { projectId: { in: clean }, ...SETTLED_DISPUTE_WHERE }, orderBy: { resolvedAt: 'desc' }, select: { id: true, projectId: true, resolution: true } });
  for (const r of rows) if (r.projectId && !out.has(r.projectId)) out.set(r.projectId, { disputeId: r.id, outcome: String(r.resolution), label: SETTLED_LABEL_AR });
  return out;
}
