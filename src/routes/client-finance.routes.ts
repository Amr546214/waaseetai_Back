import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorizeActiveRoleWithMessage, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { getClientInvoice, getClientInvoices, getClientWallet } from '../controllers/client-finance.controller';
import { createPaypalOrder, capturePaypalOrder } from '../controllers/paypal.controller';
import { createPaypalOrderSchema, capturePaypalOrderSchema } from '../dtos/paypal.dto';
import { arbAbandon, arbAvailability, arbOpenAttempt, arbPaymentStatus, arbQuote, initiateArbPayment } from '../controllers/arb.controller';
import { initiateArbPaymentSchema } from '../dtos/arb.dto';
import { paymentLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Protect all client finance endpoints
router.use(authenticate);
router.use(requireActiveUser);
// The wallet balance, invoices and the PayPal deposit are the CLIENT's money: only the role the user is ACTING as client may reach them (a provider's earnings are a separate, withdrawable balance).
router.use(authorizeActiveRoleWithMessage('بدّل إلى حساب طالب الخدمة لاستخدام المحفظة والدفع', AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL));

router.get('/wallet', getClientWallet);
router.get('/invoices', getClientInvoices);
router.get('/invoices/:id', getClientInvoice);

// PayPal (USD) is the ONLY wallet deposit rail. Same authenticated/active-user protection applied via router.use() at the top.
router.post('/paypal/order/create', paymentLimiter, validateDto(createPaypalOrderSchema), createPaypalOrder);
router.post('/paypal/order/capture', paymentLimiter, validateDto(capturePaypalOrderSchema), capturePaypalOrder);

// Bank card (ARB / Neoleap hosted page). Off unless ARB_ENABLED + every bank setting is present; the PayPal rail above is unchanged.
router.get('/arb/config', arbAvailability);
router.post('/arb/initiate', paymentLimiter, validateDto(initiateArbPaymentSchema), initiateArbPayment);
router.get('/arb/quote', arbQuote);
router.get('/arb/open', arbOpenAttempt);
router.get('/arb/:reference/status', arbPaymentStatus);
router.post('/arb/:reference/abandon', paymentLimiter, arbAbandon);

export default router;
