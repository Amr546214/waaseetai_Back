import { Router } from 'express';
import { marketerOverviewController } from '../controllers/marketer-overview.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';

const router = Router();

// Protect all routes and restrict to MARKETING_BROKER
router.use(authenticate);
router.use(authorize('MARKETING_BROKER'));

router.get('/summary', marketerOverviewController.getSummary);
router.get('/channel-performance', marketerOverviewController.getChannelPerformance);
router.get('/commissions', marketerOverviewController.getCommissions);
router.get('/ai-insights', marketerOverviewController.getAiInsights);

// Referral links
router.get('/ref-links', marketerOverviewController.getRefLinks);
router.post('/ref-links/custom', marketerOverviewController.createCustomLink);
router.patch('/ref-links/settings', marketerOverviewController.updateSettings);

export default router;
