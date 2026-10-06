import { Router } from 'express';
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

// PayPal (USD) is the ONLY wallet deposit rail. Same authenticated/active-user protection applied via router.use() at the top.
router.post('/paypal/order/create', validateDto(createPaypalOrderSchema), createPaypalOrder);
router.post('/paypal/order/capture', validateDto(capturePaypalOrderSchema), capturePaypalOrder);

export default router;
