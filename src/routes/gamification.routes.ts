import { requireApprovedProvider } from '../middlewares/provider-access.middleware';
import { Router } from 'express';
import { gamificationController } from '../controllers/gamification.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Operational: an unapproved individual provider gets 403 (level-details and any future route here).
router.use(authenticate, requireActiveUser, requireApprovedProvider);

router.get(
  '/level-details',
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY),
  gamificationController.getLevelDetails
);

export default router;
