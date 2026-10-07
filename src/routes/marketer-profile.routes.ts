import { Router } from 'express';
import { marketerProfileController } from '../controllers/marketer-profile.controller';
import { profileRequestsController } from '../controllers/profile-requests.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { apiLimiter } from '../middlewares/rate-limit.middleware';
import { marketerKycController } from '../controllers/marketer-kyc.controller';
import { memoryUpload } from '../utils/cloudinary-storage';
import { CreateIdentityRequestSchema } from '../dtos/profile-requests.dto';
import { updateBankInfoSchema, updateMarketingInfoSchema, addChannelSchema } from '../dtos/marketer-profile.dto';

const router = Router();

// Identity document: PDF / JPG / PNG / WEBP, one file, 5 MB. Stored private; there is no field through which a client could set identityVerified.
const kycUpload = memoryUpload({ fileSize: 5 * 1024 * 1024, files: 1, allowedMimeTypes: new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) });

// Public, unauthenticated — must be registered before the authenticate/
// authorize guards below (same pattern as provider-profile.routes.ts's
// `/public/:providerId`). No Gemini call here, so the plain apiLimiter is
// used rather than aiLimiter (which is reserved for AI-cost-bearing routes).
router.get('/public/:id', apiLimiter, marketerProfileController.getPublicProfile);

// Protect all routes and restrict to MARKETING_BROKER
router.use(authenticate, requireActiveUser);
router.use(authorize('MARKETING_BROKER'));

router.get('/', marketerProfileController.getProfile);
router.patch('/marketing-info', validateDto(updateMarketingInfoSchema), marketerProfileController.updateMarketingInfo);
router.post('/channels', validateDto(addChannelSchema), marketerProfileController.addChannel);
router.delete('/channels/:id', marketerProfileController.removeChannel);
router.post('/kyc-document', kycUpload.single('file'), marketerKycController.upload);
router.get('/kyc-status', marketerKycController.status);
router.patch('/bank-info', validateDto(updateBankInfoSchema), marketerProfileController.updateBankInfo);

// Change Requests
router.get('/requests', profileRequestsController.getRequests);
router.post('/requests', validateDto(CreateIdentityRequestSchema), profileRequestsController.createRequests);
router.post('/requests/:id/withdraw', profileRequestsController.withdrawRequest);

export default router;
