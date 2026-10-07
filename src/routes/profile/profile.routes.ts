import { Router } from 'express';
import { profileController } from '../../controllers/profile.controller';
import { authenticate, requireActiveUser } from '../../middlewares/auth.middleware';

import { phoneChangeController } from '../../controllers/phone-change.controller';

const router = Router();

// ==========================================
// PROFILE ROUTES (/api/profiles)
// ==========================================

router.get('/me', authenticate, requireActiveUser, profileController.getProfile);
router.get('/my-change-requests', authenticate, requireActiveUser, profileController.getMyChangeRequests);
router.put('/update', authenticate, requireActiveUser, profileController.updateProfile);
// Phone number change: a code sent to the account email confirms it (PUT /update no longer changes the number).
router.post('/phone/change/request', authenticate, requireActiveUser, phoneChangeController.request);
router.post('/phone/change/confirm', authenticate, requireActiveUser, phoneChangeController.confirm);
router.put('/update/:tabName', authenticate, requireActiveUser, profileController.updateTab);

import { blockCompanySetup } from '../../middlewares/company-unavailable.middleware';
import { profileSetupController } from '../../controllers/profile-setup.controller';

router.post('/setup', authenticate, requireActiveUser, blockCompanySetup, profileSetupController.setupProfile);

export default router;
