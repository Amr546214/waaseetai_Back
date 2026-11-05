import { CancellationRequestStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

/**
 * Freeze of an AGREED mutual cancellation («تم الاتفاق — بانتظار التسوية»): once both parties agreed, approving NEW stages and releasing their payments stops
 * (server-enforced, 423 like the dispute freeze). Before the agreement, and for everything already paid, nothing changes. Derived from the request row itself,
 * so it cannot drift. Call it INSIDE the money transaction, after the contract row lock (the agreement also takes that lock, so approval and agreement serialise).
 */
export const CANCELLATION_FROZEN_CODE = 'CONTRACT_CANCELLATION_AGREED';
export const CANCELLATION_FROZEN_MESSAGE = 'اتفق الطرفان على إلغاء العقد بالتراضي: اعتماد المراحل الجديدة وصرف دفعاتها متوقفان بانتظار تسوية الإدارة. ما صُرف سابقًا لا يتغيّر.';

type Db = { contractCancellationRequest: Pick<Prisma.TransactionClient['contractCancellationRequest'], 'findFirst'> };

/** Contract ids keyed by contract id OR project id (callers hold either). */
export async function hasAgreedCancellation(key: { contractId?: string; projectId?: string }, db: Db = prisma as unknown as Db): Promise<boolean> {
	const or: Prisma.ContractCancellationRequestWhereInput[] = [];
	if (key.contractId) or.push({ contractId: key.contractId });
	if (key.projectId) or.push({ projectId: key.projectId });
	if (!or.length || !db.contractCancellationRequest) return false;
	return !!(await db.contractCancellationRequest.findFirst({ where: { OR: or, status: CancellationRequestStatus.AGREED_PENDING_SETTLEMENT }, select: { id: true } }));
}

export async function assertNoAgreedCancellation(key: { contractId?: string; projectId?: string }, db: Db = prisma as unknown as Db): Promise<void> {
	if (await hasAgreedCancellation(key, db)) throw new AppError(CANCELLATION_FROZEN_MESSAGE, 423, [{ code: CANCELLATION_FROZEN_CODE }], CANCELLATION_FROZEN_CODE);
}
