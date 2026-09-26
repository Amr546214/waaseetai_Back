import { Router } from 'express';
import { analyzeProjectForProvider } from '../controllers/ai-assistant.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Batch 7 security fix: this route calls Gemini (a real cost-bearing call —
// see ai-assistant.controller.ts) and was missing both aiLimiter (every
// other Gemini-triggering HTTP route in the codebase carries one) and any
// role restriction. The only real callers are the provider "Explore
// Requests" and "Apply to Request" pages (deep project-fit analysis is a
// provider-side bidding tool), so the narrowest correct authorization is
// providerOnly, matching how every other provider-only Gemini route in
// provider.routes.ts is gated.
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

router.use(authenticate, requireActiveUser, providerOnly, aiLimiter);

router.get('/analyze-project/:projectId', async (req, res, next) => {
  await analyzeProjectForProvider(req, res);
});

router.post('/analyze-project', async (req, res, next) => {
  await analyzeProjectForProvider(req, res);
});

export default router;

