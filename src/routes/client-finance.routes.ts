import { Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { getClientInvoice, getClientInvoices, getClientWallet } from '../controllers/client-finance.controller';
import { createPaypalOrder, capturePaypalOrder } from '../controllers/paypal.controller';
import { createPaypalOrderSchema, capturePaypalOrderSchema } from '../dtos/paypal.dto';

const router = Router();

// Protect all client finance endpoints
router.use(authenticate);
router.use(requireActiveUser);

router.get('/wallet', getClientWallet);
router.get('/invoices', getClientInvoices);
router.get('/invoices/:id', getClientInvoice);

// Moyasar wallet top-up is TEMPORARILY DISABLED at this entry point only.
// Product decision: User.walletBalance is now USD-canonical, and Moyasar
// only verifies/credits SAR — letting a SAR deposit through here would
// silently mix currencies in the same balance. client-finance.controller.ts's
// initiateDeposit/verifyDeposit (and the whole Moyasar integration under
// moyasar.service.ts) are intentionally left completely untouched — this is
// a routing-level gate only, so re-enabling later is a one-line revert once
// Moyasar is redesigned for USD or a real multi-currency wallet exists.
const moyasarDepositDisabled = (_req: Request, res: Response) => {
	res.status(503).json({
		success: false,
		message: 'الإيداع عبر بطاقة بنكية (ميسر) متوقف مؤقتًا. يرجى استخدام PayPal للإيداع بالدولار الأمريكي حاليًا.'
	});
};
router.post('/deposit/init', moyasarDepositDisabled);
router.post('/deposit/verify', moyasarDepositDisabled);

// PayPal Sandbox wallet deposit — separate gateway from Moyasar above, same
// authenticated/active-user protection applied via router.use() at the top.
router.post('/paypal/order/create', validateDto(createPaypalOrderSchema), createPaypalOrder);
router.post('/paypal/order/capture', validateDto(capturePaypalOrderSchema), capturePaypalOrder);

export default router;
