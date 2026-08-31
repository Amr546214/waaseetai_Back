import { Router } from 'express';
import { AiReviewController } from './ai-review.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../../middlewares/auth.middleware';
import { aiLimiter } from '../../middlewares/rate-limit.middleware';

const router = Router();
const controller = new AiReviewController();

router.use(
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY),
  aiLimiter
);

// POST /api/ai-review/enhance-description
router.post('/enhance-description', controller.enhanceDescription);

// POST /api/ai-review/suggest-text
router.post('/suggest-text', controller.suggestText);

// POST /api/ai-review/suggest-milestones
router.post('/suggest-milestones', controller.suggestMilestones);

// POST /api/ai-review/analyze
router.post('/analyze', controller.analyzeProjectModel);

export default router;
