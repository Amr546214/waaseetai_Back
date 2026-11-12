import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

/**
 * The enforcement side of the admin holds (suspended request / suspended offer / frozen contract), used by the EXISTING flows so a hold is real and not only a label:
 *  - a suspended request receives no new offers and none of its offers can be chosen (the hold must end first);
 *  - a suspended offer cannot be chosen / its counter cannot be accepted;
 *  - a frozen contract runs no NEW financial movement (stage approval / release, funding, settlement, dispute financial decision), 423 like the dispute freeze.
 * The holds are columns set by admin-order-controls.service; unfreezing / resuming only clears them and executes nothing.
 */
export const REQUEST_SUSPENDED_CODE = 'REQUEST_SUSPENDED_BY_ADMIN';
export const REQUEST_SUSPENDED_MESSAGE = 'هذا الطلب معلّق مؤقتًا من إدارة المنصة ولا يستقبل عروضًا جديدة ولا يمكن اختيار عرض عليه حاليًا.';
export const OFFER_SUSPENDED_CODE = 'OFFER_SUSPENDED_BY_ADMIN';
export const OFFER_SUSPENDED_MESSAGE = 'هذا العرض معلّق مؤقتًا من إدارة المنصة ولا يمكن قبوله حاليًا.';
export const CONTRACT_FROZEN_CODE = 'CONTRACT_FROZEN_BY_ADMIN';
export const CONTRACT_FROZEN_MESSAGE = 'جمّدت إدارة المنصة هذا العقد مؤقتًا: لا تُنفَّذ عليه حركة مالية جديدة (اعتماد مراحل، صرف، تمويل) حتى يُفكّ التجميد. ما صُرف سابقًا لا يتغيّر.';

export function assertRequestNotSuspended(request: { adminSuspendedAt?: Date | null } | null | undefined): void {
	if (request?.adminSuspendedAt) throw new AppError(REQUEST_SUSPENDED_MESSAGE, 422, [{ code: REQUEST_SUSPENDED_CODE }], REQUEST_SUSPENDED_CODE);
}
export function assertOfferNotSuspended(offer: { adminSuspendedAt?: Date | null } | null | undefined): void {
	if (offer?.adminSuspendedAt) throw new AppError(OFFER_SUSPENDED_MESSAGE, 409, [{ code: OFFER_SUSPENDED_CODE }], OFFER_SUSPENDED_CODE);
}

type FreezeDb = { contract: Pick<Prisma.TransactionClient['contract'], 'findFirst'> };
/** Throws 423 while the contract is frozen by an admin. Call it INSIDE the money transaction, after the contract row lock (the freeze takes the same lock). */
export async function assertNoAdminFreeze(key: { contractId?: string; projectId?: string }, db: FreezeDb = prisma as unknown as FreezeDb): Promise<void> {
	const or: Prisma.ContractWhereInput[] = [];
	if (key.contractId) or.push({ id: key.contractId });
	if (key.projectId) or.push({ projectId: key.projectId });
	if (!or.length || !db.contract?.findFirst) return;
	const frozen = await db.contract.findFirst({ where: { OR: or, adminFrozenAt: { not: null } }, select: { id: true, adminFrozenAt: true } });
	// the row's own column decides (not only the filter), so a caller whose client ignores the filter can never read a plain contract as frozen
	if (frozen?.adminFrozenAt) throw new AppError(CONTRACT_FROZEN_MESSAGE, 423, [{ code: CONTRACT_FROZEN_CODE }], CONTRACT_FROZEN_CODE);
}

/**
 * Atomic hold check for the flows that CHOOSE / ACCEPT / CREATE an offer. It takes the row locks in the SAME order as the admin suspension / cancellation actions
 * (request row -> contract row -> offer rows), then re-reads the hold columns under those locks and refuses a suspended request / offer. Because the admin action holds the
 * same locks while it writes, either the suspension commits first (this call is refused) or this transaction commits first (the suspension then sees the new state): no interleaving
 * can produce an offer chosen / accepted / created on a suspended request or a suspended offer.
 * `opts.requireOpen` also refuses a request that is no longer OPEN (e.g. cancelled by an admin a moment ago).
 */
export async function lockAndAssertNotSuspended(
	tx: Prisma.TransactionClient,
	requestId: string,
	opts: { providerId?: string; offerId?: string; requireOpen?: boolean } = {}
): Promise<void> {
	// (the typeof guards only serve unit tests that hand in a partial transaction double; a real transaction client always has all of these)
	if (typeof tx.$queryRaw !== 'function' || typeof tx.clientRequest?.findUnique !== 'function') return;
	await tx.$queryRaw`SELECT "id" FROM "client_requests" WHERE "id" = ${requestId} FOR UPDATE`;
	await tx.$queryRaw`SELECT "id" FROM "contracts" WHERE "projectId" = ${requestId} FOR UPDATE`;
	await tx.$queryRaw`SELECT "id" FROM "project_proposals" WHERE "projectId" = ${requestId} FOR UPDATE`;
	const request = await tx.clientRequest.findUnique({ where: { id: requestId }, select: { status: true, adminSuspendedAt: true } });
	assertRequestNotSuspended(request);
	if (opts.requireOpen && request && String(request.status) !== 'OPEN') throw new AppError('هذا المشروع غير متاح حالياً لاستقبال عروض جديدة', 422, undefined, 'PROJECT_NOT_OPEN');
	if ((opts.providerId || opts.offerId) && typeof tx.projectProposal?.findFirst === 'function') {
		const offer = await tx.projectProposal.findFirst({ where: opts.offerId ? { id: opts.offerId, projectId: requestId } : { projectId: requestId, providerId: opts.providerId }, select: { adminSuspendedAt: true } });
		assertOfferNotSuspended(offer);
	}
}
