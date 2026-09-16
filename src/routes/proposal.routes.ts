import { Router } from 'express';
import { proposalController } from '../controllers/proposal.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { aiSuggestRequestSchema } from '../dtos/ai-suggest-request.dto';
import { AccountType } from '@prisma/client';

const router = Router();

// Trigger AI content refinement & market fair price evaluation
router.post(
  '/ai-suggest',
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_COMPANY, AccountType.PROVIDER_INDIVIDUAL, AccountType.MARKETING_BROKER),
  validateDto(aiSuggestRequestSchema),
  proposalController.aiSuggest
);

export default router;
