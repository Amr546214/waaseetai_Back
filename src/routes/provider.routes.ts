import { Router } from 'express';
import { getProviderStatistics, getProviderOffers, getEligibleAccreditationSpecialties, getPassedSpecialties, signContract, getActiveProjects, getArchivedProjects, getProjectProgress, submitStageDelivery, getProviderWallet, getProviderTransactions } from '../controllers/provider.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import providerProfileRouter from './provider-profile.routes';
import marketplaceServiceRouter from './marketplace-service.routes';
import { exploreRequestsController } from '../controllers/explore-requests.controller';

const router = Router();
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

// Mount profile routes
router.use('/profile', providerProfileRouter);

// Mount marketplace services routes
router.use('/services', marketplaceServiceRouter);

// Endpoint for Provider Dashboard Overview Statistics
router.get(
  '/statistics',
  authenticate,
  requireActiveUser,
  getProviderStatistics
);

router.post('/projects/:id/stages/:stageId/deliveries', authenticate, requireActiveUser, submitStageDelivery);

router.get('/finance/wallet', authenticate, requireActiveUser, getProviderWallet);
router.get('/finance/transactions', authenticate, requireActiveUser, getProviderTransactions);

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

import accreditationAiRoutes from './accreditation-ai.routes';
import aiMatchingRoutes from './ai-matching.routes';

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

// Mount AI Matching engine routes
router.use('/', aiMatchingRoutes);

export default router;
