import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { clientReportsController, clientReportsAiSummary } from '../controllers/client-reports.controller';

const router = Router();

router.get('/', authenticate, requireActiveUser, clientReportsController.getReports);

router.get('/ai-summary', authenticate, requireActiveUser, aiLimiter, clientReportsAiSummary);

export default router;
