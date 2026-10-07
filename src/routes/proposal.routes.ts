import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { proposalController } from '../controllers/proposal.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { aiSuggestRequestSchema } from '../dtos/ai-suggest-request.dto';
import { aiLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Trigger AI content refinement (title / message / advantages / quality).
// Real WaseetAI call (ai-proposal.service.ts#evaluateAndSuggestProposal) —
// needs the same aiLimiter every other AI-triggering route carries. No price
// recommendation is returned (the service cannot see the project budget).
//
// Phase 3 Batch 2B: confirmed via a full frontend trace that the only real
// caller is the apply-to-request wizard (explore-requests/:id/apply), which
// sits under the providerGuard-protected provider-overview shell —
// PROVIDER_INDIVIDUAL/PROVIDER_COMPANY only. MARKETING_BROKER is authorized
// on the sibling POST /projects/:id/proposals route, but was proven to have
// zero current frontend path to either that route or this one (no
// apply/proposal route exists anywhere in the marketer dashboard) — so it is
// deliberately NOT included here; that would be an unproven, aspirational
// grant rather than a fix backed by current product wiring.
router.post(
  '/ai-suggest',
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY),
  aiLimiter,
  validateDto(aiSuggestRequestSchema),
  proposalController.aiSuggest
);

export default router;
