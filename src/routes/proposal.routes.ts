import { Router } from 'express';
import { proposalController } from '../controllers/proposal.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { aiSuggestRequestSchema } from '../dtos/ai-suggest-request.dto';

const router = Router();

// Trigger AI content refinement & market fair price evaluation
router.post(
  '/ai-suggest',
  authenticate,
  validateDto(aiSuggestRequestSchema),
  proposalController.aiSuggest
);

export default router;
