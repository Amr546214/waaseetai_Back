import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminAffiliateRequestsController } from '../controllers/admin-affiliate-requests.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('identity.review'));

router.get('/', adminAffiliateRequestsController.listRequests);
router.get('/:id', adminAffiliateRequestsController.getRequest);
router.post('/:id/approve', adminAffiliateRequestsController.approve);
router.post('/:id/reject', adminAffiliateRequestsController.reject);

export default router;
