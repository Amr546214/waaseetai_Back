import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { getClientInvoice, getClientInvoices, getClientWallet, initiateDeposit, verifyDeposit } from '../controllers/client-finance.controller';

const router = Router();

// Protect all client finance endpoints
router.use(authenticate);
router.use(requireActiveUser);

router.get('/wallet', getClientWallet);
router.get('/invoices', getClientInvoices);
router.get('/invoices/:id', getClientInvoice);
router.post('/deposit/init', initiateDeposit);
router.post('/deposit/verify', verifyDeposit);

export default router;
