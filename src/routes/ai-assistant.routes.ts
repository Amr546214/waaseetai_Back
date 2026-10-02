import { Router } from 'express';
import { analyzeProjectForProvider } from '../controllers/ai-assistant.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// The handler is currently disabled (503 AI_FEATURE_UNAVAILABLE; no WaseetAI
// contract yet) but keeps provider-only authorization and aiLimiter so the
// route is correctly gated once re-enabled.
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

router.use(authenticate, requireActiveUser, providerOnly, aiLimiter);

router.get('/analyze-project/:projectId', async (req, res, next) => {
  await analyzeProjectForProvider(req, res);
});

router.post('/analyze-project', async (req, res, next) => {
  await analyzeProjectForProvider(req, res);
});

export default router;

