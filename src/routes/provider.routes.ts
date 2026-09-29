import { Router, Request, Response, NextFunction } from 'express';
import { getProviderStatistics, getProviderOffers, getEligibleAccreditationSpecialties, getPassedSpecialties, signContract, getActiveProjects, getArchivedProjects, getProjectProgress, submitStageDelivery, getDeliveryAiReview, getProjectHealthAnalysis, getProviderWallet, getProviderTransactions, getCompanyDeliveries } from '../controllers/provider.controller';
import { submitWithdrawal, listMyWithdrawals } from '../controllers/withdrawal.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import providerProfileRouter from './provider-profile.routes';
import marketplaceServiceRouter from './marketplace-service.routes';
import { exploreRequestsController } from '../controllers/explore-requests.controller';
import { openProviderDispute, cancelProviderRequest, listMyDisputes, getMyDispute } from '../controllers/dispute.controller';
import { createTicket, listMyTickets, getMyTicket, replyToTicket, closeMyTicket } from '../controllers/support-ticket.controller';
import { rateAsProvider } from '../controllers/rating.controller';
import { createCoupon, deactivateCoupon, getCoupon, listCoupons, updateCoupon, decideCouponApproval, getCouponStats } from '../controllers/provider-coupon.controller';
import companyTeamRouter from './company-team.routes';
import specialOfferRouter from './provider-special-offer.routes';
import marketingCenterRouter from './provider-marketing-center.routes';
import { AppError } from '../utils/app-error';

const router = Router();
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

// Phase 5 — same strict-accountType pattern as company-team.routes.ts's own
// requireCompanyAccount: authorize(PROVIDER_COMPANY) alone also admits any
// user holding the PROVIDER role via role-equivalence, which would let a
// PROVIDER_INDIVIDUAL through. Coupon approval only makes sense for a
// company account (an individual coupon is always auto-approved and never
// reaches PENDING), so this enforces the strict accountType on top.
const requireCompanyAccount = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.accountType !== AccountType.PROVIDER_COMPANY) {
    return next(new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403));
  }
  next();
};

// Mount profile routes
router.use('/profile', providerProfileRouter);

// Mount marketplace services routes
router.use('/services', marketplaceServiceRouter);

// Company team roster CRUD (PROVIDER_COMPANY accounts only — gated inside
// the sub-router) → /api/provider/company/team
router.use('/company/team', companyTeamRouter);

router.post('/coupons', authenticate, requireActiveUser, providerOnly, createCoupon);
router.get('/coupons', authenticate, requireActiveUser, providerOnly, listCoupons);
router.get('/coupons/:id/stats', authenticate, requireActiveUser, providerOnly, getCouponStats);
router.get('/coupons/:id', authenticate, requireActiveUser, providerOnly, getCoupon);
router.put('/coupons/:id', authenticate, requireActiveUser, providerOnly, updateCoupon);
router.delete('/coupons/:id', authenticate, requireActiveUser, providerOnly, deactivateCoupon);
router.patch('/coupons/:id/approval', authenticate, requireActiveUser, authorize(AccountType.PROVIDER_COMPANY), requireCompanyAccount, decideCouponApproval);

// Phase 6 — special offers CRUD + company approval → /api/provider/special-offers
router.use('/special-offers', specialOfferRouter);

// Phase 7 — marketing center aggregation + company spend cap → /api/provider/marketing
router.use('/marketing', marketingCenterRouter);

// Endpoint for Provider Dashboard Overview Statistics. Internally calls
// providerOverviewService.getAiMatchingProjects -> aiMatchingEngineService
// .getTop3MatchingProjects, a real Gemini call — needs aiLimiter like every
// other Gemini-triggering route (Batch 6 gap fix; this route was missing it).
//
// Phase 3 Batch 2B: confirmed via a full frontend trace that every real
// caller (the shared dashboard sidebar, gated on effectiveRole()===PROVIDER,
// and the provider overview page itself) is provider-only — no other role's
// dashboard ever calls this endpoint. The data itself is also inherently
// provider-specific (queries keyed by providerId). Restricted accordingly.
router.get(
  '/statistics',
  authenticate,
  requireActiveUser,
  providerOnly,
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

// Provider's own disputes — list/detail, scoped to disputes where this
// provider is the opener or the respondent (see DisputeService.listForUser).
router.get('/disputes', authenticate, requireActiveUser, providerOnly, listMyDisputes);
router.get('/disputes/:id', authenticate, requireActiveUser, providerOnly, getMyDispute);

// Provider's own support tickets — same generic, userId-scoped model and
// service the client-side tickets router uses (see SupportTicketService).
router.post('/tickets', authenticate, requireActiveUser, createTicket);
router.get('/tickets', authenticate, requireActiveUser, listMyTickets);
router.get('/tickets/:id', authenticate, requireActiveUser, getMyTicket);
router.post('/tickets/:id/reply', authenticate, requireActiveUser, replyToTicket);
router.post('/tickets/:id/close', authenticate, requireActiveUser, closeMyTicket);

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
