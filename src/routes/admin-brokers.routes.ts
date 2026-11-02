import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { marketerKycController } from '../controllers/marketer-kyc.controller';
import { getBrokerDetail, listBrokers, setBrokerStatus } from '../controllers/admin-brokers.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser);

router.get('/', requirePermission('users.view'), listBrokers);
// marketer identity-document review (declared before '/:id'); only an admin can reach it, a marketer can never approve themselves
router.get('/kyc-requests', requirePermission('identity.review'), marketerKycController.listPending);
router.post('/kyc-requests/:id/approve', requirePermission('identity.review'), marketerKycController.approve);
router.post('/kyc-requests/:id/reject', requirePermission('identity.review'), marketerKycController.reject);
router.get('/:id', requirePermission('users.view'), getBrokerDetail);
router.patch('/:id/status', requirePermission('users.suspend'), setBrokerStatus);

export default router;
