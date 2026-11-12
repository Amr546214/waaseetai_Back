import { NotificationCategory, Prisma } from '@prisma/client';
import { logger } from '../config/logger';
import { CLIENT_LEVELS } from '../config/levels.config';
import { CASHBACK_FORMULA_CODE, CASHBACK_LADDER_SOURCE, CashbackBlockReason, cashbackGate, computeCashback } from '../config/cashback-policy';
import { round2 } from '../utils/money';
import { loadClientLevelFacts } from './gamification.service';
import { CLIENT_ROUTES } from './client-notifications.service';
import { notificationService } from './notification.service';

/**
 * Client cashback on a project COMPLETED BY DELIVERY (the final stage approval). One durable ledger row per contract (`client_cashback_entries`, unique contractId and eventKey), the wallet credit
 * (WalletTransaction CASHBACK, unique reference) and the ledger row are written in the CALLER'S transaction, so a failure anywhere rolls all of it back and a retry / replay / parallel twin cannot accrue twice.
 *
 *  - never for an administrative closure (release / refund / cancel) or a consensual cancellation: those paths never call this, and it refuses when an EngagementClosure exists;
 *  - eligible value = what the escrow ACTUALLY released for the service at completion (escrow.releasedAmount): net of any marketplace discount (the contract price is already net), and it never includes a refunded
 *    part (refunds / amendment reductions leave the escrow) nor fees (the escrow holds only the service price);
 *  - K39..K43 of the workbook sheet «الأرباح» exactly (config/cashback-policy.ts): level rate, rating factor from the client's REAL average rating, payment factor from input K38; points are never money;
 *  - activation stays BLOCKED behind a specific reason code for what the workbook does not define (K38 meaning/source, a client with no rating, the wallet timing).
 */
export type CashbackOutcome =
	| { status: 'CREDITED'; amount: number; level: number; ratePercent: number; eligibleValue: number; ratingFactor: number; paymentFactor: number; notice: CashbackNotice }
	| { status: 'DUPLICATE' }
	| { status: 'SKIPPED'; reason: 'NOT_DELIVERY_COMPLETION' | 'NOTHING_RELEASED' | 'ZERO_RATE' | 'NO_ESCROW' }
	| { status: 'BLOCKED'; reason: CashbackBlockReason };
export interface CashbackNotice { userId: string; amount: number; contractId: string; projectId: string }

export const cashbackEventKey = (contractId: string) => `CASHBACK:DELIVERY_COMPLETED:${contractId}`;

/**
 * Input K38 (the payment input). The workbook does not define it (see config/cashback-policy.ts), so production passes none and the accrual is BLOCKED with
 * CASHBACK_PAYMENT_SPEED_INPUT_UNDEFINED; a test (and, later, the approved source) supplies the number.
 */
export interface CashbackInputs { paymentInput?: number | null }

export async function accrueCashbackForDeliveryCompletion(
	tx: Prisma.TransactionClient,
	contract: { id: string; projectId: string; clientId: string },
	env: NodeJS.ProcessEnv = process.env,
	inputs: CashbackInputs = {}
): Promise<CashbackOutcome> {
	const gate = cashbackGate(env);
	if (gate) return { status: 'BLOCKED', reason: gate };
	if (typeof inputs.paymentInput !== 'number' || !Number.isFinite(inputs.paymentInput)) return { status: 'BLOCKED', reason: 'CASHBACK_PAYMENT_SPEED_INPUT_UNDEFINED' };
	// an engagement closed by an administrative / consensual decision is never a delivery completion
	if (await tx.engagementClosure.findUnique({ where: { projectId: contract.projectId }, select: { id: true } })) return { status: 'SKIPPED', reason: 'NOT_DELIVERY_COMPLETION' };
	const escrow = await tx.escrow.findUnique({ where: { projectId: contract.projectId }, select: { releasedAmount: true, status: true } });
	if (!escrow) return { status: 'SKIPPED', reason: 'NO_ESCROW' };
	const eligibleValue = round2(escrow.releasedAmount ?? 0);
	if (!(eligibleValue > 0)) return { status: 'SKIPPED', reason: 'NOTHING_RELEASED' };

	// level BEFORE this project counts, from the SAME computation as the level page / dashboard: real ratings the client received from providers (never a hardcoded 0)
	const facts = await loadClientLevelFacts(contract.clientId, { excludeProjectId: contract.projectId }, tx);
	// K41 needs the client's average rating; no ratings = no input (never invented, never read as 0)
	if (facts.avgRating === null) return { status: 'BLOCKED', reason: 'CASHBACK_RATING_INPUT_MISSING' };
	const level = facts.progression.currentLevelIndex;
	const ratePercent = CLIENT_LEVELS[Math.min(CLIENT_LEVELS.length, Math.max(1, level)) - 1].percent; // K39
	const calc = computeCashback({ qualifiedVolume: eligibleValue, ratePercent, avgRating: facts.avgRating, paymentInput: inputs.paymentInput });
	const amount = calc.amount;
	if (!(amount > 0)) return { status: 'SKIPPED', reason: 'ZERO_RATE' };

	const eventKey = cashbackEventKey(contract.id);
	const walletReference = `CASHBACK-${contract.id}`;
	// ON CONFLICT DO NOTHING on the unique keys: a duplicate is reported as count 0 and leaves the caller's transaction healthy
	const { count } = await tx.clientCashbackEntry.createMany({ skipDuplicates: true, data: [{
		userId: contract.clientId, contractId: contract.id, projectId: contract.projectId, eventKey, eligibleValue, level, ratePercent, ladderSource: CASHBACK_LADDER_SOURCE,
		policyCode: CASHBACK_FORMULA_CODE, ratingInput: facts.avgRating, paymentInput: inputs.paymentInput, ratingFactor: calc.ratingFactor, paymentFactor: calc.paymentFactor, amount, currency: 'USD', walletReference
	}] });
	if (count === 0) return { status: 'DUPLICATE' };
	await tx.user.update({ where: { id: contract.clientId }, data: { walletBalance: { increment: amount } } });
	await tx.walletTransaction.create({ data: {
		userId: contract.clientId, type: 'CASHBACK', amount, currency: 'USD', status: 'COMPLETED', paymentMethod: 'CASHBACK', referenceId: walletReference,
		description: 'كاش باك مشروع مكتمل', metadata: { contractId: contract.id, projectId: contract.projectId, eligibleValue, level, ratePercent, ratingFactor: calc.ratingFactor, paymentFactor: calc.paymentFactor, ratingInput: facts.avgRating, paymentInput: inputs.paymentInput, ladderSource: CASHBACK_LADDER_SOURCE, formula: CASHBACK_FORMULA_CODE, eventKey }
	} });
	return { status: 'CREDITED', amount, level, ratePercent, eligibleValue, ratingFactor: calc.ratingFactor, paymentFactor: calc.paymentFactor, notice: { userId: contract.clientId, amount, contractId: contract.id, projectId: contract.projectId } };
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
