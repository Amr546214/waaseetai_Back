import { requireApprovedProvider } from '../../middlewares/provider-access.middleware';
import { Router } from 'express';
import { AiReviewController } from './ai-review.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorizeActiveRole, requireActiveUser } from '../../middlewares/auth.middleware';
import { aiLimiter } from '../../middlewares/rate-limit.middleware';

const router = Router();
const controller = new AiReviewController();

router.use(
  authenticate,
  requireActiveUser,
  authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY),
  requireApprovedProvider, // operational AI helper: unapproved individual providers get 403
  aiLimiter
);

// POST /api/ai-review/suggest-milestones
router.post('/suggest-milestones', controller.suggestMilestones);

// POST /api/ai-review/analyze
router.post('/analyze', controller.analyzeProjectModel);

export default router;
