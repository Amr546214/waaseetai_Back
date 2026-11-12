import { NotificationCategory, Prisma } from '@prisma/client';
import { logger } from '../config/logger';
import { CLIENT_LEVELS } from '../config/levels.config';
import { CASHBACK_LADDER_SOURCE, CashbackBlockReason, CashbackPolicy, activeCashbackPolicy } from '../config/cashback-policy';
import { deriveRequesterProgression } from '../utils/progression-calculators';
import { round2 } from '../utils/money';
import { deliveryCompletedProject } from './settlement-state.service';
import { CLIENT_ROUTES } from './client-notifications.service';
import { notificationService } from './notification.service';

/**
 * Client cashback on a project COMPLETED BY DELIVERY (the final stage approval). One durable ledger row per contract (`client_cashback_entries`, unique contractId and eventKey), the wallet credit
 * (WalletTransaction CASHBACK, unique reference) and the ledger row are written in the CALLER'S transaction, so a failure anywhere rolls all of it back and a retry / replay / parallel twin cannot accrue twice.
 *
 *  - never for an administrative closure (release / refund / cancel) or a consensual cancellation: those paths never call this, and it refuses when an EngagementClosure exists;
 *  - eligible value = what the escrow ACTUALLY released for the service at completion (escrow.releasedAmount): net of any marketplace discount (the contract price is already net), and it never includes a refunded
 *    part (refunds / amendment reductions leave the escrow) nor fees (the escrow holds only the service price);
 *  - the rate is the client's level % (levels.config CLIENT_LEVELS) read from the level BEFORE this project counts; points are never money and never an input except through the level;
 *  - the coefficients / >=80 gate / wallet timing are blocked behind CASHBACK_POLICY_UNAPPROVED until the owner approves one option (config/cashback-policy.ts).
 */
export type CashbackOutcome =
	| { status: 'CREDITED'; amount: number; level: number; ratePercent: number; eligibleValue: number; notice: CashbackNotice }
	| { status: 'DUPLICATE' }
	| { status: 'SKIPPED'; reason: 'NOT_DELIVERY_COMPLETION' | 'NOTHING_RELEASED' | 'ZERO_RATE' | 'NO_ESCROW' }
	| { status: 'BLOCKED'; reason: CashbackBlockReason };
export interface CashbackNotice { userId: string; amount: number; contractId: string; projectId: string }

export const cashbackEventKey = (contractId: string) => `CASHBACK:DELIVERY_COMPLETED:${contractId}`;

export async function accrueCashbackForDeliveryCompletion(
	tx: Prisma.TransactionClient,
	contract: { id: string; projectId: string; clientId: string },
	env: NodeJS.ProcessEnv = process.env
): Promise<CashbackOutcome> {
	const gate = activeCashbackPolicy(env);
	if ('blocked' in gate) return { status: 'BLOCKED', reason: gate.blocked };
	const policy: CashbackPolicy = gate.policy;
	// an engagement closed by an administrative / consensual decision is never a delivery completion
	if (await tx.engagementClosure.findUnique({ where: { projectId: contract.projectId }, select: { id: true } })) return { status: 'SKIPPED', reason: 'NOT_DELIVERY_COMPLETION' };
	const escrow = await tx.escrow.findUnique({ where: { projectId: contract.projectId }, select: { releasedAmount: true, status: true } });
	if (!escrow) return { status: 'SKIPPED', reason: 'NO_ESCROW' };
	const eligibleValue = round2(escrow.releasedAmount ?? 0);
	if (!(eligibleValue > 0)) return { status: 'SKIPPED', reason: 'NOTHING_RELEASED' };

	// level BEFORE this project counts (the project is already COMPLETED inside the caller's transaction, so it is excluded explicitly)
	const [profile, completedBefore] = await Promise.all([
		tx.clientProfile.findUnique({ where: { userId: contract.clientId }, select: { currentPoints: true } }),
		tx.project.count({ where: deliveryCompletedProject({ clientId: contract.clientId, id: { not: contract.projectId } }) })
	]);
	const level = deriveRequesterProgression({ points: Math.max(0, profile?.currentPoints || 0), completedProjects: completedBefore, avgRating: 0 }).currentLevelIndex;
	const ratePercent = CLIENT_LEVELS[Math.min(CLIENT_LEVELS.length, Math.max(1, level)) - 1].percent;
	const amount = round2(eligibleValue * (ratePercent / 100) * policy.ratingFactor * policy.paymentFactor);
	if (!(amount > 0)) return { status: 'SKIPPED', reason: 'ZERO_RATE' };

	const eventKey = cashbackEventKey(contract.id);
	const walletReference = `CASHBACK-${contract.id}`;
	// ON CONFLICT DO NOTHING on the unique keys: a duplicate is reported as count 0 and leaves the caller's transaction healthy
	const { count } = await tx.clientCashbackEntry.createMany({ skipDuplicates: true, data: [{
		userId: contract.clientId, contractId: contract.id, projectId: contract.projectId, eventKey, eligibleValue, level, ratePercent, ladderSource: CASHBACK_LADDER_SOURCE,
		policyCode: policy.code, ratingFactor: policy.ratingFactor, paymentFactor: policy.paymentFactor, amount, currency: 'USD', walletReference
	}] });
	if (count === 0) return { status: 'DUPLICATE' };
	await tx.user.update({ where: { id: contract.clientId }, data: { walletBalance: { increment: amount } } });
	await tx.walletTransaction.create({ data: {
		userId: contract.clientId, type: 'CASHBACK', amount, currency: 'USD', status: 'COMPLETED', paymentMethod: 'CASHBACK', referenceId: walletReference,
		description: 'كاش باك مشروع مكتمل', metadata: { contractId: contract.id, projectId: contract.projectId, eligibleValue, level, ratePercent, ladderSource: CASHBACK_LADDER_SOURCE, policyCode: policy.code, eventKey }
	} });
	return { status: 'CREDITED', amount, level, ratePercent, eligibleValue, notice: { userId: contract.clientId, amount, contractId: contract.id, projectId: contract.projectId } };
}

/** After the commit only; a failure never undoes the credit. */
export async function notifyCashbackCredited(n: CashbackNotice | null | undefined): Promise<void> {
	if (!n) return;
	try {
		await notificationService.createAndEmit({
			userId: n.userId, title: 'أُضيف كاش باك إلى محفظتك', message: `أُضيف ${round2(n.amount)} $ إلى محفظتك كاش باك على مشروعك المكتمل. يظهر في سجل المعاملات.`,
			category: NotificationCategory.FINANCIAL, type: 'CASHBACK_CREDITED', actionUrl: CLIENT_ROUTES.wallet, actionText: 'عرض المحفظة', metadata: { contractId: n.contractId, projectId: n.projectId, amount: n.amount }
		});
	} catch (e) { logger.error(`[cashback] notification failed: ${(e as Error)?.message}`); }
}
