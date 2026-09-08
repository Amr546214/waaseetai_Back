import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminListOnboarding, adminGetOnboarding, adminApproveOnboarding, adminRejectOnboarding, adminListProviderKyc, adminApproveProviderKyc, adminRejectProviderKyc } from '../controllers/onboarding.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

// Provider KYC review (must be before /:id to avoid path conflict)
router.get('/kyc/providers', adminListProviderKyc);
router.post('/kyc/providers/:userId/approve', adminApproveProviderKyc);
router.post('/kyc/providers/:userId/reject', adminRejectProviderKyc);

// Client onboarding review
router.get('/', adminListOnboarding);
router.get('/:id', adminGetOnboarding);
router.post('/:id/approve', adminApproveOnboarding);
router.post('/:id/reject', adminRejectOnboarding);

export default router;
