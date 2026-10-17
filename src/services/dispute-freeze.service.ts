import { DisputeStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

/**
 * Dispute freeze (policy "B", derived): while at least one dispute of a project is OPEN / UNDER_REVIEW the project is FROZEN for
 * approvals and money. Nothing is stored: the freeze IS the dispute rows, so it can never drift from them and needs no migration.
 *
 *   frozen             -> client stage APPROVAL, any escrow release, financial project completion
 *   still allowed      -> chat, evidence, provider delivery uploads/submissions, revision requests, withdrawing already-released earnings
 *
 * With several active disputes on one project the freeze lasts until ALL of them are RESOLVED / REJECTED.
 * Disputes are keyed by Dispute.projectId, or by Dispute.requestId for legacy requests (whose Project shares the request id).
 */
export const ACTIVE_DISPUTE_STATUSES: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW];

export const PROJECT_FROZEN_CODE = 'PROJECT_FROZEN_BY_DISPUTE';
export const PROJECT_FROZEN_MESSAGE = 'اعتماد المراحل وصرف الأموال موقوفان بسبب نزاع مفتوح على هذا المشروع إلى أن تحسمه الإدارة. التواصل ورفع الأدلة وتسليم الأعمال متاحة.';

/** Anything with a `dispute` delegate: the global client or an interactive-transaction client. */
export type DisputeDb = { dispute: Pick<Prisma.TransactionClient['dispute'], 'count' | 'findMany' | 'findFirst'> };

const activeWhere = (projectId: string): Prisma.DisputeWhereInput => ({
  OR: [{ projectId }, { requestId: projectId }],
  status: { in: ACTIVE_DISPUTE_STATUSES }
});

/** How many OPEN / UNDER_REVIEW disputes the project has. */
export async function countActiveDisputes(projectId: string, db: DisputeDb = prisma): Promise<number> {
  return db.dispute.count({ where: activeWhere(projectId) });
}

/** True while the project is frozen by a dispute. Pass the transaction client to check inside the same transaction as a release. */
export async function hasActiveDispute(projectId: string, db: DisputeDb = prisma): Promise<boolean> {
  return (await countActiveDisputes(projectId, db)) > 0;
}
export const isProjectFrozen = hasActiveDispute;

/** The newest active dispute (for display / deep links), or null. */
export async function getActiveDisputeForProject(projectId: string, db: DisputeDb = prisma) {
  return db.dispute.findFirst({ where: activeWhere(projectId), orderBy: { createdAt: 'desc' }, select: { id: true, status: true, openedById: true, createdAt: true } });
}

export interface FreezeState {
  frozen: boolean;
  activeDisputeCount: number;
  /** The newest active dispute id, for a link; null when not frozen. */
  disputeId: string | null;
  disputeStatus: DisputeStatus | null;
  reason: string | null;
}

/** The read model both apps use: one object, same shape on every endpoint that exposes it. */
export async function getFreezeState(projectId: string, db: DisputeDb = prisma): Promise<FreezeState> {
  const [count, latest] = await Promise.all([countActiveDisputes(projectId, db), getActiveDisputeForProject(projectId, db)]);
  return freezeStateOf(count, latest);
}

export function freezeStateOf(count: number, latest: { id: string; status: DisputeStatus } | null): FreezeState {
  const frozen = count > 0;
  return { frozen, activeDisputeCount: count, disputeId: frozen ? latest?.id ?? null : null, disputeStatus: frozen ? latest?.status ?? null : null, reason: frozen ? PROJECT_FROZEN_MESSAGE : null };
}

/** Throws 423 (Locked) when the project is frozen. Call it INSIDE the release transaction, after lockProjectForFreezeCheck. */
export async function assertProjectNotFrozen(projectId: string, db: DisputeDb = prisma): Promise<void> {
  if (await hasActiveDispute(projectId, db)) {
    throw new AppError(PROJECT_FROZEN_MESSAGE, 423, [{ code: PROJECT_FROZEN_CODE }]);
  }
}

/**
 * Serialises "open a dispute" against "approve / release / settle" on the SAME row: the project's contract. Every one of them first takes
 * that row lock (SELECT ... FOR UPDATE), so whichever transaction gets it second sees the other's COMMITTED state: either the dispute exists
 * before the release checks (release refused) or the release is fully committed before the dispute is created. A release can therefore
 * never slip past a dispute opened "at the same time". Returns false when the project has no contract row.
 */
export async function lockProjectForFreezeCheck(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, projectId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "contracts" WHERE "projectId" = ${projectId} FOR UPDATE`;
  return Array.isArray(rows) && rows.length > 0;
}
