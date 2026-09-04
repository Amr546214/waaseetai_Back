import { Router } from 'express';
import { startDynamicSession } from '../controllers/provider-assessment.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { requireOwnedProviderSpecialtyFromBody } from '../utils/provider-specialty-access';

const router = Router();

router.post(
  '/start-dynamic-session',
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY),
  requireOwnedProviderSpecialtyFromBody,
  startDynamicSession
);

export default router;
