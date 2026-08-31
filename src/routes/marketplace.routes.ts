import { Router } from 'express';
import { MarketplaceServiceController } from '../controllers/marketplace-service.controller';
import { authenticate, requireActiveUser, authorize } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';

const router = Router();
const controller = new MarketplaceServiceController();

router.get('/models', controller.getMarketplaceModels.bind(controller));
router.get('/models/:id', controller.getMarketplaceModelById.bind(controller));
router.get('/categories', controller.getMarketplaceCategories.bind(controller));
router.post('/ai-recommendations', aiLimiter, controller.getAiRecommendations.bind(controller));
router.get('/favorites', authenticate, requireActiveUser, controller.getFavorites.bind(controller));
router.put('/models/:id/favorite', authenticate, requireActiveUser, controller.setFavorite.bind(controller));
router.post('/models/:id/request', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), controller.requestService.bind(controller));
router.get('/', controller.getMarketplaceModels.bind(controller));

export default router;
