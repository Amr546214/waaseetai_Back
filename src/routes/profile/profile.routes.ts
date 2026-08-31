import { Router } from 'express';
import { profileController } from '../../controllers/profile.controller';
import { authenticate, requireActiveUser } from '../../middlewares/auth.middleware';

const router = Router();

// ==========================================
// PROFILE ROUTES (/api/profiles)
// ==========================================

router.get('/me', authenticate, requireActiveUser, profileController.getProfile);
router.get('/my-change-requests', authenticate, requireActiveUser, profileController.getMyChangeRequests);
router.put('/update', authenticate, requireActiveUser, profileController.updateProfile);
router.put('/update/:tabName', authenticate, requireActiveUser, profileController.updateTab);

import { profileSetupController } from '../../controllers/profile-setup.controller';

router.post('/setup', authenticate, requireActiveUser, profileSetupController.setupProfile);

export default router;
