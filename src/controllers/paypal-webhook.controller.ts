import { Request, Response, NextFunction } from 'express';
import { paypalService } from '../services/paypal.service';
import { paypalFinanceService } from '../services/paypal-finance.service';

// Minimum event set for this first implementation — do not widen without a
// corresponding internal flow to react to the new event.
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
