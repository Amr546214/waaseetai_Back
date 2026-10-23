import { Request, Response, NextFunction } from 'express';
import { arbPaymentService } from '../services/arb-payment.service';
import { CLIENT_ROUTES } from '../services/client-notifications.service';
import { logger } from '../config/logger';
import { siteBaseUrl } from '../utils/site-url';

const userIdOf = (req: Request): string | null => ((req as any).user?.id as string | undefined) ?? null;

/** the customer address the bank requires first in X-FORWARDED-FOR (guide p.13); `req.ip` honours the configured trust-proxy hops */
export function customerIpOf(req: Request): string {
	const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
	return ip || 'unknown';
}

export const arbAvailability = (req: Request, res: Response) => {
	res.json({ success: true, data: { available: arbPaymentService.isAvailable(userIdOf(req) ?? '') } });
};

export const initiateArbPayment = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const uid = userIdOf(req);
		if (!uid) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await arbPaymentService.initiate(uid, (req.body as { netUsd: number }).netUsd, customerIpOf(req));
		return res.status(200).json({ success: true, data });
	} catch (error) { next(error); }
};

export const arbQuote = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const n = Number(req.query.netUsd);
		return res.status(200).json({ success: true, data: arbPaymentService.quote(userIdOf(req) ?? '', n) });
	} catch (error) { next(error); }
};

export const arbOpenAttempt = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const uid = userIdOf(req);
		if (!uid) return res.status(401).json({ success: false, message: 'غير مصرح' });
		return res.status(200).json({ success: true, data: await arbPaymentService.openAttemptFor(uid) });
	} catch (error) { next(error); }
};

export const arbPaymentStatus = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const uid = userIdOf(req);
		if (!uid) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await arbPaymentService.statusFor(uid, String(req.params.reference));
		return res.status(200).json({ success: true, data });
	} catch (error) { next(error); }
};

const frontendBase = () => siteBaseUrl() ?? '';
const walletReturn = (ref: string | null) => `${frontendBase()}${CLIENT_ROUTES.wallet}?arb=${encodeURIComponent(ref ?? 'unknown')}`;
const pick = (req: Request) => ({ ...(req.query as Record<string, unknown>), ...((req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>) });

/**
 * responseURL / errorURL: the BROWSER arrives here from the bank page (GET or POST). Nothing in the request is shown or trusted; it only tells us which
 * attempt to verify with the bank. The user is always sent on to the wallet page, which asks the server for the verified state.
 */
const browserReturn = (kind: 'response' | 'error') => async (req: Request, res: Response) => {
	try {
		const p = pick(req);
		const out = kind === 'response' ? await arbPaymentService.handleReturn({ paymentId: p.paymentId ?? p.PaymentID ?? p.paymentid, trandata: p.trandata }) : await arbPaymentService.handleError({ paymentId: p.paymentId ?? p.PaymentID ?? p.paymentid, trandata: p.trandata });
		return res.redirect(303, walletReturn(out.reference));
	} catch (e) {
		logger.error(`[ARB] ${kind} return failed: ${(e as Error)?.message}`);
		return res.redirect(303, walletReturn(null));
	}
};
export const arbBrowserResponse = browserReturn('response');
export const arbBrowserError = browserReturn('error');

/** Bank-to-server notification (guide p.187-194). The answer decides whether the bank keeps or voids the transaction, so it is exact. */
export const arbNotification = async (req: Request, res: Response) => {
	try {
		const p = pick(req);
		const out = await arbPaymentService.handleNotification({ paymentId: p.paymentId, trandata: p.trandata });
		if (out.ack) return res.status(200).json([{ status: '1', result: out.responseUrl }]);
		return res.status(400).json([{ status: '2', result: null }]);
	} catch (e) {
		logger.error(`[ARB] notification failed: ${(e as Error)?.message}`);
		return res.status(500).json([{ status: '2', result: null }]); // no acknowledgement: the bank reverses (p.187 step 4); nothing was credited
	}
};
