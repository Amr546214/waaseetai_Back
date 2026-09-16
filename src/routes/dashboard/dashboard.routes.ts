import { Router } from 'express';
import { dashboardController } from '../../controllers/dashboard.controller';
import { authenticate, requireActiveUser } from '../../middlewares/auth.middleware';
import { aiLimiter } from '../../middlewares/rate-limit.middleware';

const router = Router();

// Expose unified endpoint, natively protected by global authentication middleware
router.get(
  '/stats',
  authenticate,
  requireActiveUser,
  dashboardController.getStats.bind(dashboardController)
);

router.post(
  '/finance/ai-insights',
  authenticate,
  requireActiveUser,
  aiLimiter,
  dashboardController.analyzeFinanceReport.bind(dashboardController)
);

export default router;
