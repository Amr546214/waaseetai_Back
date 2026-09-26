import { Router } from 'express';
import { getProviderStatistics, getProviderOffers, getEligibleAccreditationSpecialties, getPassedSpecialties, signContract, getActiveProjects, getArchivedProjects, getProjectProgress, submitStageDelivery, getDeliveryAiReview, getProjectHealthAnalysis, getProviderWallet, getProviderTransactions, getCompanyDeliveries } from '../controllers/provider.controller';
import { submitWithdrawal, listMyWithdrawals } from '../controllers/withdrawal.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import providerProfileRouter from './provider-profile.routes';
import marketplaceServiceRouter from './marketplace-service.routes';
import { exploreRequestsController } from '../controllers/explore-requests.controller';
import { openProviderDispute, cancelProviderRequest } from '../controllers/dispute.controller';
import { rateAsProvider } from '../controllers/rating.controller';
import { createCoupon, deactivateCoupon, getCoupon, listCoupons, updateCoupon } from '../controllers/provider-coupon.controller';

const router = Router();
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

// Mount profile routes
router.use('/profile', providerProfileRouter);

// Mount marketplace services routes
router.use('/services', marketplaceServiceRouter);

router.post('/coupons', authenticate, requireActiveUser, providerOnly, createCoupon);
router.get('/coupons', authenticate, requireActiveUser, providerOnly, listCoupons);
router.get('/coupons/:id', authenticate, requireActiveUser, providerOnly, getCoupon);
router.put('/coupons/:id', authenticate, requireActiveUser, providerOnly, updateCoupon);
router.delete('/coupons/:id', authenticate, requireActiveUser, providerOnly, deactivateCoupon);

// Endpoint for Provider Dashboard Overview Statistics. Internally calls
// providerOverviewService.getAiMatchingProjects -> aiMatchingEngineService
// .getTop3MatchingProjects, a real Gemini call — needs aiLimiter like every
// other Gemini-triggering route (Batch 6 gap fix; this route was missing it).
router.get(
  '/statistics',
  authenticate,
  requireActiveUser,
  aiLimiter,
  getProviderStatistics
);

router.post('/projects/:id/stages/:stageId/deliveries', authenticate, requireActiveUser, submitStageDelivery);
// Advisory-only Gemini review of the provider's own stage delivery —
// read-only, no DB write, never approves/rejects it. AI-rate-limited like
// every other Gemini-triggering HTTP route. Ownership (must be this
// contract's own provider) is enforced inside the shared service method.
router.post('/projects/:id/stages/:stageId/ai-review', authenticate, requireActiveUser, aiLimiter, getDeliveryAiReview);

// Batch 8 — advisory-only Gemini project health analysis. Read-only, no DB
// write, never changes any status. Ownership (must be this contract's own
// client or provider) is enforced inside the shared service method.
router.post('/projects/:id/health', authenticate, requireActiveUser, aiLimiter, getProjectHealthAnalysis);

// Real deliveries list replacing team-deliveries.ts's fully hardcoded
// fictional "company deliveries" data (Batch 7). Deterministic — no
// Gemini call, so no aiLimiter needed (same rationale as /projects/active).
router.get('/company/deliveries', authenticate, requireActiveUser, providerOnly, getCompanyDeliveries);

router.get('/finance/wallet', authenticate, requireActiveUser, getProviderWallet);
router.get('/finance/transactions', authenticate, requireActiveUser, getProviderTransactions);
router.post('/finance/withdrawals', authenticate, requireActiveUser, providerOnly, submitWithdrawal);
router.get('/finance/withdrawals', authenticate, requireActiveUser, listMyWithdrawals);

// Endpoint for Provider Submitted Offers tracking and AI analysis
router.get(
  '/offers',
  authenticate,
  requireActiveUser,
  getProviderOffers
);

router.post(
  '/offers/:id/sign',
  authenticate,
  requireActiveUser,
  signContract
);

router.get(
  '/projects/active',
  authenticate,
  requireActiveUser,
  getActiveProjects
);

router.get(
  '/projects/archived',
  authenticate,
  requireActiveUser,
  getArchivedProjects
);

router.get(
  '/projects/:id/progress',
  authenticate,
  requireActiveUser,
  getProjectProgress
);

router.get(
  '/explore-requests',
  authenticate,
  requireActiveUser,
  exploreRequestsController.getExploreRequests
);

router.post(
  '/explore-requests/:id/toggle-save',
  authenticate,
  requireActiveUser,
  exploreRequestsController.toggleSave
);

router.post('/requests/:id/disputes', authenticate, requireActiveUser, providerOnly, openProviderDispute);
router.post('/requests/:id/rate', authenticate, requireActiveUser, providerOnly, rateAsProvider);
router.post('/requests/:id/cancel', authenticate, requireActiveUser, providerOnly, cancelProviderRequest);

import accreditationAiRoutes from './accreditation-ai.routes';

// Accreditation Routing
router.get(
  '/accreditation/eligible-specialties',
  authenticate,
  requireActiveUser,
	providerOnly,
  getEligibleAccreditationSpecialties
);

router.get(
  '/accreditation/passed-specialties',
  authenticate,
  requireActiveUser,
	providerOnly,
  getPassedSpecialties
);

// Mount full accreditation submission & AI evaluation routes
router.use('/accreditation', accreditationAiRoutes);

// Batch 8: the standalone `GET /ai-matching-projects` route (ai-matching.
// routes.ts/ai-matching.controller.ts) was removed here — confirmed zero
// real frontend callers (only a dead, never-invoked provider-api.service.ts
// method pointed at it) and confirmed to call the exact same
// aiMatchingEngineService.getTop3MatchingProjects() already live and wired
// through /statistics above. The underlying service is untouched.

export default router;
