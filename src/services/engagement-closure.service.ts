import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { createCommissionsForStageReleaseEvent } from './affiliate-commission.service';
import type { MarketerCommissionNotice } from './marketer-notifications.service';

/**
 * How an engagement was CLOSED by a new decision, stored explicitly and separately from the dispute and from the cancellation request (whose state / history are never touched here):
 *   ADMIN_RELEASE   administrative release of the held balance to the provider (contract / request / project COMPLETED, but NOT completed by delivery)
 *   ADMIN_REFUND    administrative refund of the held balance to the client (CANCELLED)
 *   ADMIN_CANCEL    administrative cancellation with no held money (CANCELLED)
 *   CONSENSUAL_CANCEL  mutual cancellation, settled by the administration (CANCELLED whatever the provider's paid-out share)
 * Only NEW decisions write a row; nothing historical is rewritten or backfilled. The row id is also the financial-event identity of the money it released (commission source).
 */
export const CLOSURE_KINDS = ['ADMIN_RELEASE', 'ADMIN_REFUND', 'ADMIN_CANCEL', 'CONSENSUAL_CANCEL'] as const;
export type ClosureKind = typeof CLOSURE_KINDS[number];
export type ClosureSource = 'ADMIN_DECISION' | 'MUTUAL_AGREEMENT';

export const CLOSURE_LABEL_AR: Record<ClosureKind, string> = {
	ADMIN_RELEASE: 'أُغلق بصرف إداري',
	ADMIN_REFUND: 'أُلغي بإعادة المبلغ للطالب بقرار إداري',
	ADMIN_CANCEL: 'أُلغي بقرار إداري',
	CONSENSUAL_CANCEL: 'أُلغي بالتراضي'
};
export const CLOSURE_SOURCE_LABEL_AR: Record<ClosureSource, string> = { ADMIN_DECISION: 'قرار إداري', MUTUAL_AGREEMENT: 'اتفاق الطرفين وتسوية الإدارة' };
export const ADMIN_RELEASE_NO_DELIVERY_AR = 'أُغلق المشروع بصرف إداري للمبلغ المحتجز، لا باعتماد العميل للمراحل. لا يُحتسب تسليمًا مكتملًا ولا يفتح تقييم التسليم.';

export interface ClosureInput {
	projectId: string; contractId: string | null; requestId: string | null;
	kind: ClosureKind; source: ClosureSource; reason: string | null; decidedById: string; cancellationRequestId?: string | null;
	escrowId?: string | null; feePolicyVersion?: number | null;
	heldBefore: number; refundToClient: number; releaseToProvider: number; platformCommission: number; providerNet: number;
}

/**
 * Writes the closure row INSIDE the caller's transaction (so a failure rolls it back with the money) and, when the provider's share was newly released, accrues the partner commission through the SAME
 * engine as stage releases with this closure as the financial event (no stage is invented). Returns the commission notices to deliver AFTER the commit.
 */
export async function recordEngagementClosure(tx: Prisma.TransactionClient, input: ClosureInput, contract: { id: string; projectId: string; clientId: string; providerId: string } | null): Promise<{ closureId: string; commissionNotices: MarketerCommissionNotice[] }> {
	const row = await tx.engagementClosure.create({ data: {
		projectId: input.projectId, contractId: input.contractId, requestId: input.requestId, kind: input.kind, source: input.source, reason: input.reason, decidedById: input.decidedById,
		cancellationRequestId: input.cancellationRequestId ?? null, escrowId: input.escrowId ?? null, feePolicyVersion: input.feePolicyVersion ?? null,
		heldBefore: input.heldBefore, refundToClient: input.refundToClient, releaseToProvider: input.releaseToProvider, platformCommission: input.platformCommission, providerNet: input.providerNet
	} });
	let commissionNotices: MarketerCommissionNotice[] = [];
	if (contract && input.releaseToProvider > 0) {
		commissionNotices = (await createCommissionsForStageReleaseEvent(tx, { contract, eventId: row.id, releasedAmount: input.releaseToProvider })) ?? [];
	}
	return { closureId: row.id, commissionNotices };
}

/** The closure of one project (or null): a read for display / counters / rating. */
export async function closureOf(projectId: string, db: { engagementClosure: { findUnique: (a: any) => Promise<any> } } = prisma as any) {
	return db.engagementClosure.findUnique({ where: { projectId } });
}

export async function closuresByProject(ids: string[], db: { engagementClosure: { findMany: (a: any) => Promise<any[]> } } = prisma as any): Promise<Map<string, { kind: ClosureKind; source: ClosureSource }>> {
	const clean = Array.from(new Set(ids.filter(Boolean)));
	const out = new Map<string, { kind: ClosureKind; source: ClosureSource }>();
	if (!clean.length || !db.engagementClosure) return out;
	for (const r of await db.engagementClosure.findMany({ where: { projectId: { in: clean } }, select: { projectId: true, kind: true, source: true } })) out.set(r.projectId, { kind: r.kind, source: r.source });
	return out;
}
