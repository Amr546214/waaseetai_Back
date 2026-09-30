import { Router } from 'express';
import { MarketplaceServiceController } from '../controllers/marketplace-service.controller';
import { authenticate, optionalAuthenticate, requireActiveUser, authorize } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';

const router = Router();
const controller = new MarketplaceServiceController();

// Batch 4 — optionalAuthenticate: these two stay fully public (a guest gets
// the exact same response as before), but when a logged-in Client happens to
// be browsing, req.user lets the service read back that Client's own
// active-purchase eligibility in the SAME batched query as the listing/detail
// data — never a per-card my-purchase request. See marketplace-service.service.ts.
router.get('/models', optionalAuthenticate, controller.getMarketplaceModels.bind(controller));
router.get('/models/:id', optionalAuthenticate, controller.getMarketplaceModelById.bind(controller));
router.get('/categories', controller.getMarketplaceCategories.bind(controller));
router.post('/ai-recommendations', aiLimiter, controller.getAiRecommendations.bind(controller));
router.get('/favorites', authenticate, requireActiveUser, controller.getFavorites.bind(controller));
router.put('/models/:id/favorite', authenticate, requireActiveUser, controller.setFavorite.bind(controller));
// Phase 4 — the signed-in client's own active purchase of this service (if any),
// so the offer page can show "under execution" instead of a buy button. Scoped
// to req.user.id; returns nothing about any other client's purchases.
router.get('/models/:id/my-purchase', authenticate, requireActiveUser, controller.getMyPurchaseStatus.bind(controller));
router.post('/models/:id/request', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), controller.requestService.bind(controller));
router.get('/', optionalAuthenticate, controller.getMarketplaceModels.bind(controller));

export default router;
