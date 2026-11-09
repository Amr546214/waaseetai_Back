import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { getAnalyticsOverview } from '../controllers/admin-analytics.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

import adminSavedReports from './admin-saved-reports.routes';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('finance.read'));

// Read-only real aggregates (see services/admin-analytics.service.ts).
router.get('/overview', getAnalyticsOverview);

router.use('/saved-reports', adminSavedReports);

export default router;
