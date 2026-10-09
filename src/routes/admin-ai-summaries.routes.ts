import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { getForecastSummary, getAnomalySummary, getSentimentSummary } from '../controllers/admin-ai-summaries.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN), aiLimiter);

// Read-only AI summaries over real aggregates (see ai-features/admin-ai-summaries.service.ts).
router.get('/forecast-summary', getForecastSummary);
router.get('/anomaly-summary', getAnomalySummary);
router.get('/sentiment-summary', getSentimentSummary);

export default router;
