import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { marketerKycController } from '../controllers/marketer-kyc.controller';
import { getBrokerDetail, listBrokers } from '../controllers/admin-brokers.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

router.get('/', listBrokers);
// marketer identity-document review (declared before '/:id'); only an admin can reach it, a marketer can never approve themselves
router.get('/kyc-requests', marketerKycController.listPending);
router.post('/kyc-requests/:id/approve', marketerKycController.approve);
router.post('/kyc-requests/:id/reject', marketerKycController.reject);
router.get('/:id', getBrokerDetail);

export default router;
