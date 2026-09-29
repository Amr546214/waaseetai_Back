import { Request, Response, NextFunction } from 'express';
import { paypalService } from '../services/paypal.service';
import { paypalFinanceService } from '../services/paypal-finance.service';
import { payoutWebhookService, SUPPORTED_PAYOUT_EVENT_TYPES } from '../services/payout-webhook.service';
import { isPayoutAutomationEnabled } from '../utils/payout-automation.util';

// Minimum event set for this first implementation — do not widen without a
// corresponding internal flow to react to the new event. Deliberately kept
// completely separate from payout-webhook.service.ts's own
// SUPPORTED_PAYOUT_EVENT_TYPES (Payout P3-D) — a deposit event must never
// reach payout processing, and a payout event must never reach
// paypalFinanceService/the deposit handlers below.
const SUPPORTED_EVENT_TYPES = new Set(['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED']);

/**
 * Public PayPal webhook endpoint — no WaseetAI JWT. Authenticity comes
 * entirely from PayPal's own webhook signature verification API, checked
 * before a single byte of the event is trusted. Any failure to verify, or
 * any unsupported event, is acknowledged without ever touching the wallet.
 */
export const handlePaypalWebhook = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const transmissionId = req.header('paypal-transmission-id');
		const transmissionTime = req.header('paypal-transmission-time');
		const certUrl = req.header('paypal-cert-url');
		const authAlgo = req.header('paypal-auth-algo');
		const transmissionSig = req.header('paypal-transmission-sig');

		if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
			return res.status(400).json({ success: false, message: 'رؤوس توقيع PayPal مفقودة' });
		}

		const webhookEvent = req.body;

		let verified = false;
		try {
			verified = await paypalService.verifyWebhookSignature({
				transmissionId,
				transmissionTime,
				certUrl,
				authAlgo,
				transmissionSig,
				webhookEvent
			});
		} catch {
			verified = false;
		}

		if (!verified) {
			// Never process an unverified payload, regardless of what it claims.
			return res.status(400).json({ success: false, message: 'توقيع PayPal غير صالح' });
		}

		const eventType = webhookEvent?.event_type;
		const resource = webhookEvent?.resource;

		if (SUPPORTED_PAYOUT_EVENT_TYPES.has(eventType)) {
			// Payout P3-D — an entirely separate pipeline (durable dedup,
			// narrow correlation, delegation to reconcilePayoutAttempt()).
			// Never touches paypalFinanceService/the wallet-deposit path
			// below. Never leaks internal error detail into the response.
			//
			// Release gate: P3-D is excluded from this release (its tables
			// have no migration yet — see utils/payout-automation.util.ts).
			// Ack the webhook honestly without calling into
			// processPayoutWebhookEvent(), which would otherwise hit a
			// missing table. PayPal only needs a 2xx to stop retrying; this
			// never touches the deposit path below either way.
			if (!isPayoutAutomationEnabled()) {
				return res.status(200).json({ success: true, message: 'تم الاستلام — معالجة التحويلات الآلية غير مفعّلة في هذا الإصدار' });
			}
			const result = await payoutWebhookService.processPayoutWebhookEvent(webhookEvent);
			let message = 'تم الاستلام';
			if (result.httpStatus === 400) message = 'حمولة إشعار PayPal للتحويل غير صالحة';
			else if (result.httpStatus >= 500) message = 'حدث خطأ غير متوقع أثناء معالجة إشعار التحويل';
			return res.status(result.httpStatus).json({ success: result.httpStatus < 300, message });
		}

		if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
			// Valid signature, but an event we don't act on — ack, no side effects.
			return res.status(200).json({ success: true, message: 'تم الاستلام' });
		}

		const paypalOrderId = resource?.supplementary_data?.related_ids?.order_id;
		if (!paypalOrderId) {
			return res.status(200).json({ success: true, message: 'تم الاستلام' });
		}

		if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
			await paypalFinanceService.completeFromWebhook({
				paypalOrderId,
				paypalCaptureId: resource.id,
				currency: resource.amount?.currency_code,
				amountValue: resource.amount?.value
			});
		} else if (eventType === 'PAYMENT.CAPTURE.DENIED') {
			await paypalFinanceService.denyFromWebhook(paypalOrderId);
		}

		return res.status(200).json({ success: true, message: 'تم الاستلام' });
	} catch (error) {
		next(error);
	}
};
