import { Router } from 'express';
import { MarketplaceServiceController } from '../controllers/marketplace-service.controller';
import { authenticate, requireActiveUser, authorize } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

const router = Router();
const controller = new MarketplaceServiceController();

const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

router.get('/my-market-models', authenticate, requireActiveUser, providerOnly, controller.getMyMarketModels.bind(controller));
router.post('/re-audit-all', authenticate, requireActiveUser, authorize(AccountType.SUPER_ADMIN, AccountType.ADMIN), controller.reAuditAllPendingModels.bind(controller));
router.post('/publish', authenticate, requireActiveUser, providerOnly, controller.publishBusinessModel.bind(controller));
router.post('/', authenticate, requireActiveUser, providerOnly, controller.publishBusinessModel.bind(controller));

export default router;
