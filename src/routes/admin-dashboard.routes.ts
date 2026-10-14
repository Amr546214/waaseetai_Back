import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { getDashboardActivity, getDashboardCharts, getDashboardSummary } from '../controllers/admin-dashboard.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

// Read-only aggregates over the real tables (see services/admin-dashboard.service.ts).
router.get('/summary', getDashboardSummary);
router.get('/charts', getDashboardCharts);
router.get('/activity', getDashboardActivity);

export default router;
