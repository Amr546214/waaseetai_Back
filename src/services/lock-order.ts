import { Prisma } from '@prisma/client';

/**
 * CANONICAL ROW-LOCK ORDER for everything that touches one engagement (request / project / contract / escrow / offers). A transaction that needs several of these rows takes them in THIS order and
 * never goes back; PostgreSQL then cannot deadlock two of them against each other (it would otherwise abort one with 40P01 and the caller would see a 500):
 *
 *   1. client_requests      (the request row, id = project id)          <- lockRequestRow()
 *   2. contracts            (by projectId)                              <- lockProjectForFreezeCheck()  (dispute-freeze.service)
 *   3. project_proposals    (all offers of the request)                 <- admin-hold.lockAndAssertNotSuspended() / admin actions
 *   4. everything else, after the three above: escrows, stages, projects, wallets, disputes, cancellation requests, amendments, audit rows.
 *
 * Why the request comes first: a dispute / offer row INSERT takes a FOR KEY SHARE lock on the request row (foreign key), which conflicts with the FOR UPDATE the admin actions hold; and several
 * flows UPDATE the request AFTER locking the contract (final stage approval, provider signing, funding, the consensual-cancellation settlement, the financial dispute decision). The admin actions
 * (admin-order-controls.service) and selectOffer / createProposal / counter accept already took the request first; every one of those flows now does the same through lockRequestRow().
 * Only the ORDER changed: no amount, status rule, permission or policy of any flow.
 */
export async function lockRequestRow(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, requestId: string | null | undefined): Promise<void> {
	// (the typeof guard only serves unit tests that hand in a partial transaction double; a real transaction client always has $queryRaw)
	if (!requestId || typeof (tx as any)?.$queryRaw !== 'function') return;
	await tx.$queryRaw`SELECT "id" FROM "client_requests" WHERE "id" = ${requestId} FOR UPDATE`;
}
