import { requireApprovedProvider } from '../../middlewares/provider-access.middleware';
import { Router } from 'express';
import { dashboardController } from '../../controllers/dashboard.controller';
import { authenticate, requireActiveUser } from '../../middlewares/auth.middleware';

const router = Router();

// Expose unified endpoint, natively protected by global authentication middleware
router.get(
  '/stats',
  authenticate,
  requireActiveUser,
  requireApprovedProvider, // provider-acting individuals get 403 until approved; other roles untouched
  dashboardController.getStats.bind(dashboardController)
);

export default router;
