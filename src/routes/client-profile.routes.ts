import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { apiLimiter } from '../middlewares/rate-limit.middleware';
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
router.post('/setup', clientProfileController.saveSetupData);
router.post('/nafath-verify', clientProfileController.nafathVerify);

export default router;
