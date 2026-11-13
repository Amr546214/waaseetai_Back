import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { blockCompanySetup } from '../middlewares/company-unavailable.middleware';
import { apiLimiter, aiLimiter } from '../middlewares/rate-limit.middleware';
import { clientProfileController } from '../controllers/client-profile.controller';

const router = Router();

// Public, unauthenticated — must be registered before the authenticate
// guard below (same pattern as marketer-profile.routes.ts's `/public/:id`
// and provider-profile.routes.ts's `/public/:providerId`). No Gemini call
// here, so apiLimiter is used rather than aiLimiter.
router.get('/public/:id', apiLimiter, clientProfileController.getPublicProfile);

// Protect all routes below
router.use(authenticate, requireActiveUser);

router.get('/setup', clientProfileController.getSetupData);
router.get('/setup/identity', clientProfileController.getIdentityState);
router.put('/setup/identity', blockCompanySetup, clientProfileController.saveIdentityStep);
router.post('/setup', blockCompanySetup, clientProfileController.saveSetupData);
router.put('/setup/step/:step', blockCompanySetup, clientProfileController.saveSetupStep);
router.post('/nafath-verify', clientProfileController.nafathVerify);
router.post('/verify-id-document', aiLimiter, clientProfileController.verifyIdentityDocument);

export default router;
