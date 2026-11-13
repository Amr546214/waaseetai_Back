import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminListOnboarding, adminGetOnboarding, adminApproveOnboarding, adminRejectOnboarding, adminListProviderKyc, adminApproveProviderKyc, adminRejectProviderKyc } from '../controllers/onboarding.controller';
import { adminGetIdentityCheck } from '../controllers/identity-field-check.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('identity.review'));

// Advisory automatic ID field check result (read-only; permission identity.review via the router guard; must be before /:id)
router.get('/identity-check/:userId', adminGetIdentityCheck);

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
