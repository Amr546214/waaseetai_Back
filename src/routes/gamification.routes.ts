import { Router } from 'express';
import { gamificationController } from '../controllers/gamification.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

router.get(
  '/level-details',
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY),
  gamificationController.getLevelDetails
);

export default router;
