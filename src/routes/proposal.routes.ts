import { Router } from 'express';
import { proposalController } from '../controllers/proposal.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { aiSuggestRequestSchema } from '../dtos/ai-suggest-request.dto';
import { aiLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Trigger AI content refinement & market fair price evaluation. Real
// Gemini call (ai-proposal.service.ts#evaluateAndSuggestProposal) — needs
// the same aiLimiter every other Gemini-triggering route carries (Batch 6
// gap fix; this route was missing it).
router.post(
  '/ai-suggest',
  authenticate,
  aiLimiter,
  validateDto(aiSuggestRequestSchema),
  proposalController.aiSuggest
);

export default router;
