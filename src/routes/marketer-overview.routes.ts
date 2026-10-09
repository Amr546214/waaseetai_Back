import { Router } from 'express';
import { marketerOverviewController } from '../controllers/marketer-overview.controller';
import { submitMarketerWithdrawal, listMyMarketerWithdrawals } from '../controllers/withdrawal.controller';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';

const router = Router();

// Protect all routes and restrict to MARKETING_BROKER
router.use(authenticate, requireActiveUser);
router.use(authorize('MARKETING_BROKER'));

router.get('/summary', marketerOverviewController.getSummary);
router.get('/channel-performance', marketerOverviewController.getChannelPerformance);
router.get('/commissions', marketerOverviewController.getCommissions);
router.get('/ai-insights', aiLimiter, marketerOverviewController.getAiInsights);

// Referred users (paginated) — strictly scoped to req.user.id's own
// AffiliateProfile inside the service (getOrCreateProfile()); never accepts
// another affiliate's id.
router.get('/referrals', marketerOverviewController.getReferrals);

// Referral links
router.get('/ref-links', marketerOverviewController.getRefLinks);
router.post('/ref-links/custom', marketerOverviewController.createCustomLink);
router.patch('/ref-links/settings', marketerOverviewController.updateSettings);

// Withdrawals — reuses the same generic, userId-scoped Withdrawal model and
// listMyWithdrawals controller the provider finance flow already uses.
router.post('/withdrawals', submitMarketerWithdrawal);
router.get('/withdrawals', listMyMarketerWithdrawals);

export default router;
