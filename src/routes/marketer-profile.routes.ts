import { Router } from 'express';
import { marketerProfileController } from '../controllers/marketer-profile.controller';
import { profileRequestsController } from '../controllers/profile-requests.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { CreateIdentityRequestSchema } from '../dtos/profile-requests.dto';

const router = Router();

// Protect all routes and restrict to MARKETING_BROKER
router.use(authenticate);
router.use(authorize('MARKETING_BROKER'));

router.get('/', marketerProfileController.getProfile);
router.patch('/marketing-info', marketerProfileController.updateMarketingInfo);
router.post('/channels', marketerProfileController.addChannel);
router.delete('/channels/:id', marketerProfileController.removeChannel);
router.patch('/bank-info', marketerProfileController.updateBankInfo);

// Change Requests
router.get('/requests', profileRequestsController.getRequests);
router.post('/requests', validateDto(CreateIdentityRequestSchema), profileRequestsController.createRequests);
router.post('/requests/:id/withdraw', profileRequestsController.withdrawRequest);

export default router;
