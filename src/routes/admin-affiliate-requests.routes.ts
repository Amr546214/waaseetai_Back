import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminAffiliateRequestsController } from '../controllers/admin-affiliate-requests.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

router.get('/', adminAffiliateRequestsController.listRequests);
router.get('/:id', adminAffiliateRequestsController.getRequest);
router.post('/:id/approve', adminAffiliateRequestsController.approve);
router.post('/:id/reject', adminAffiliateRequestsController.reject);

export default router;
