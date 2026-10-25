import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { getAnalyticsOverview } from '../controllers/admin-analytics.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('finance.read'));

// Read-only real aggregates (see services/admin-analytics.service.ts).
router.get('/overview', getAnalyticsOverview);

export default router;
