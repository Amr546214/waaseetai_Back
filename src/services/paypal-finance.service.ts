import { prisma } from '../config/db';
import { paypalService } from './paypal.service';
import { clientFinanceService } from './client-finance.service';
import { LogCategory, LogStatus, Prisma, PaypalPaymentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppError } from '../utils/app-error';

// Same numeric bounds as the existing Moyasar deposit flow, now in USD (see
// dtos/paypal.dto.ts for the shared rationale — this is a deliberate reuse
// of the existing limit, not a converted value).
const MIN_DEPOSIT_USD = 50;
const MAX_DEPOSIT_USD = 100000;

export class PaypalFinanceService {
	/**
	 * Creates a PayPal order for a wallet deposit. The PayPal order is created
	 * FIRST; the pending PaypalPayment row is only persisted once PayPal
	 * confirms the order — a create failure therefore never leaves behind a
	 * row at all, let alone one that looks successful.
	 */
	async initiateDeposit(clientId: string, amount: number) {
		if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USD || amount > MAX_DEPOSIT_USD) {
			throw new AppError(`المبلغ يجب أن يكون بين ${MIN_DEPOSIT_USD} و ${MAX_DEPOSIT_USD.toLocaleString('en-US')} دولار أمريكي`, 400);
		}

		const normalizedAmount = new Prisma.Decimal(amount).toDecimalPlaces(2);
		const reference = randomUUID();

		const order = await paypalService.createOrder({
			amount: normalizedAmount.toFixed(2),
			currency: 'USD',
			referenceId: reference,
			customId: clientId
		});

		if (!order?.id) {
			throw new AppError('تعذر إنشاء طلب الدفع عبر PayPal', 502);
		}

		await prisma.paypalPayment.create({
			data: {
				userId: clientId,
				reference,
				paypalOrderId: order.id,
				amount: normalizedAmount,
				currency: 'USD',
				status: PaypalPaymentStatus.PENDING
			}
		});

		return { paypalOrderId: order.id };
	}

	/**
	 * Captures a previously-created order server-side and, only after full
	 * verification, credits the wallet. Safe to call repeatedly for the same
	 * order: an already-COMPLETED or already-FAILED payment short-circuits
	 * without contacting PayPal again or touching the wallet again.
	 */
	async captureDeposit(clientId: string, paypalOrderId: string) {
		const payment = await prisma.paypalPayment.findUnique({ where: { paypalOrderId } });
		if (!payment) {
			throw new AppError('طلب الدفع غير موجود', 404);
		}
		if (payment.userId !== clientId) {
			throw new AppError('طلب الدفع هذا لا يخص هذا المستخدم', 403);
		}

		if (payment.status === PaypalPaymentStatus.COMPLETED) {
			// Idempotent no-op: already credited (by this same endpoint on a
			// retry, or by the webhook arriving first).
			return clientFinanceService.getWallet(clientId);
		}
		if (payment.status === PaypalPaymentStatus.FAILED) {
			throw new AppError('تم رفض عملية الدفع هذه سابقاً عبر PayPal', 409);
		}

		const captureResponse = await paypalService.captureOrder(paypalOrderId);
		const capture = captureResponse.purchase_units?.[0]?.payments?.captures?.[0];
		const purchaseUnit = captureResponse.purchase_units?.[0];

		if (!capture || capture.status !== 'COMPLETED') {
			await this.markFailedIfPending(payment.id);
			throw new AppError('لم تكتمل عملية الدفع عبر PayPal', 402);
		}

		// From here down, PayPal itself reports the capture as COMPLETED — real
		// money moved on PayPal's side. Each of the next three checks is us
		// rejecting that capture for a reason PayPal doesn't know about, so
		// each must ALSO transition the row to FAILED before throwing —
		// otherwise a genuinely-captured payment sits at PENDING forever,
		// indistinguishable from an order the user simply never approved (see
		// markFailedIfPending()'s own comment for why this is conditional).
		if (purchaseUnit?.custom_id && purchaseUnit.custom_id !== clientId) {
			await this.markFailedIfPending(payment.id);
			throw new AppError('طلب الدفع لا يخص هذا المستخدم', 403);
		}

		if (!capture.amount || capture.amount.currency_code !== 'USD') {
			await this.markFailedIfPending(payment.id);
			throw new AppError('عملة عملية الدفع لا تطابق الدولار الأمريكي', 400);
		}

		// Exact decimal comparison — never a floating-point equality check.
		const capturedAmount = new Prisma.Decimal(capture.amount.value);
		if (!capturedAmount.equals(payment.amount)) {
			await this.markFailedIfPending(payment.id);
			throw new AppError('مبلغ الدفع لا يطابق المبلغ المسجل لهذا الطلب', 400);
		}

		await this.creditWalletForCapture(payment, capture.id, capturedAmount);
		return clientFinanceService.getWallet(clientId);
	}

	/**
	 * Webhook path for PAYMENT.CAPTURE.COMPLETED. Converges on the exact same
	 * credit operation as captureDeposit() so whichever path arrives first
	 * (authenticated capture response, or this webhook) wins, and the other
	 * safely becomes a no-op.
	 */
	async completeFromWebhook(params: { paypalOrderId: string; paypalCaptureId: string; currency: string; amountValue: string }) {
		const payment = await prisma.paypalPayment.findUnique({ where: { paypalOrderId: params.paypalOrderId } });
		if (!payment) {
			// Unknown order — nothing in our system to reconcile against. Ack
			// without any financial side effect.
			return { handled: false as const };
		}
		if (payment.status === PaypalPaymentStatus.COMPLETED) {
			return { handled: true as const, alreadyCompleted: true as const };
		}
		if (payment.status === PaypalPaymentStatus.FAILED) {
			// A DENIED webhook (or a failed capture attempt) already closed this
			// out; a later COMPLETED event for the same order is not trusted
			// blindly — leave it for manual review rather than crediting.
			return { handled: false as const };
		}

		// Same reasoning as captureDeposit()'s equivalent checks: PayPal has
		// already told us this capture COMPLETED, so a currency/amount
		// mismatch here is us rejecting real captured money for a reason
		// PayPal doesn't know about — the row must move to FAILED, not stay
		// silently PENDING forever, indistinguishable from an abandoned order.
		if (params.currency !== 'USD') {
			await this.markFailedIfPending(payment.id);
			return { handled: false as const };
		}
		const capturedAmount = new Prisma.Decimal(params.amountValue);
		if (!capturedAmount.equals(payment.amount)) {
			await this.markFailedIfPending(payment.id);
			return { handled: false as const };
		}

		await this.creditWalletForCapture(payment, params.paypalCaptureId, capturedAmount);
		return { handled: true as const, alreadyCompleted: false as const };
	}

	/** Webhook path for PAYMENT.CAPTURE.DENIED — marks the payment failed, never touches the wallet. */
	async denyFromWebhook(paypalOrderId: string) {
		await prisma.paypalPayment.updateMany({
			where: { paypalOrderId, status: PaypalPaymentStatus.PENDING },
			data: { status: PaypalPaymentStatus.FAILED }
		});
	}

	/**
	 * Conditionally transitions a payment PENDING -> FAILED. The `status:
	 * PENDING` guard in the WHERE clause is what makes this safe to call from
	 * a validation-rejection branch that might be racing a legitimate
	 * concurrent credit: if the payment was already moved to COMPLETED by the
	 * other path (capture endpoint or webhook, whichever wins the race) before
	 * this runs, the update matches zero rows and does nothing — an
	 * already-COMPLETED payment can never be downgraded back to FAILED.
	 */
	private async markFailedIfPending(paymentId: string): Promise<void> {
		await prisma.paypalPayment.updateMany({
			where: { id: paymentId, status: PaypalPaymentStatus.PENDING },
			data: { status: PaypalPaymentStatus.FAILED }
		});
	}

	/**
	 * The single place that ever increments a wallet for PayPal. Relies on
	 * WalletTransaction.referenceId's DB-level unique constraint (not just the
	 * pre-check) as the real idempotency guarantee — a concurrent duplicate
	 * insert for the same PayPal capture ID fails atomically (P2002) and is
	 * treated as "already credited", exactly mirroring the existing Moyasar
	 * deposit flow's own race handling.
	 */
	private async creditWalletForCapture(payment: { id: string; userId: string }, captureId: string, verifiedAmount: Prisma.Decimal) {
		const existing = await prisma.walletTransaction.findFirst({ where: { referenceId: captureId } });
		if (existing) {
			await prisma.paypalPayment.updateMany({
				where: { id: payment.id, status: PaypalPaymentStatus.PENDING },
				data: { status: PaypalPaymentStatus.COMPLETED, paypalCaptureId: captureId }
			});
			return;
		}

		try {
			await prisma.$transaction(async tx => {
				await tx.walletTransaction.create({
					data: {
						userId: payment.userId,
						type: 'DEPOSIT',
						amount: verifiedAmount.toNumber(),
						currency: 'USD',
						status: 'COMPLETED',
						paymentMethod: 'PAYPAL',
						referenceId: captureId,
						description: 'إيداع رصيد بالمحفظة عبر PayPal',
						metadata: { paypalPaymentId: payment.id, paypalCaptureId: captureId }
					}
				});

				await tx.user.update({
					where: { id: payment.userId },
					data: { walletBalance: { increment: verifiedAmount.toNumber() } }
				});

				await tx.paypalPayment.update({
					where: { id: payment.id },
					data: { status: PaypalPaymentStatus.COMPLETED, paypalCaptureId: captureId }
				});

				await tx.accountAuditLog.create({
					data: {
						userId: payment.userId,
						category: LogCategory.SYSTEM_AUDIT,
						title: 'إيداع رصيد بالمحفظة',
						actionText: `إيداع بمبلغ ${verifiedAmount.toFixed(2)} دولار عبر PayPal`,
						status: LogStatus.COMPLETED,
						statusText: 'مكتمل بنجاح',
						summary: `تم شحن المحفظة بمبلغ ${verifiedAmount.toFixed(2)} دولار - رقم عملية PayPal: ${captureId}`,
						source: 'USER',
						eventType: 'WALLET_DEPOSIT_COMPLETED',
						severity: 'INFO'
					}
				});

				await tx.notification.create({
					data: {
						userId: payment.userId,
						title: 'تم إيداع الرصيد بنجاح',
						message: `أُضيف مبلغ ${verifiedAmount.toFixed(2)} دولار إلى رصيد محفظتك عبر PayPal، يمكنك الآن استخدامه لتمويل المشاريع.`,
						type: 'FINANCIAL',
						category: 'FINANCIAL',
						actionUrl: '/dashboard/clients-overview/finance/wallet',
						actionText: 'عرض المحفظة'
					}
				});
			});
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
				// Lost the race to a concurrent credit for the same capture ID —
				// treat exactly like the pre-check above, not as a failure.
				await prisma.paypalPayment.updateMany({
					where: { id: payment.id, status: PaypalPaymentStatus.PENDING },
					data: { status: PaypalPaymentStatus.COMPLETED, paypalCaptureId: captureId }
				});
				return;
			}
			throw error;
		}
	}
}

export const paypalFinanceService = new PaypalFinanceService();
