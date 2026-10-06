import { Router } from 'express';
import { analyzeProjectForProvider } from '../controllers/ai-assistant.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Provider-only, aiLimiter. The handler answers through the internal LlmClient (503 when the model is unavailable).
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

router.use(authenticate, requireActiveUser, providerOnly, aiLimiter);

router.get('/analyze-project/:projectId', (req, res, next) => analyzeProjectForProvider(req, res, next));

router.post('/analyze-project', (req, res, next) => analyzeProjectForProvider(req, res, next));

export default router;

