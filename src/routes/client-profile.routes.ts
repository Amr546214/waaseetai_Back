import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { clientProfileController } from '../controllers/client-profile.controller';

const router = Router();

// Protect all routes below
router.use(authenticate);

router.get('/setup', clientProfileController.getSetupData);
router.post('/setup', clientProfileController.saveSetupData);
router.post('/nafath-verify', clientProfileController.nafathVerify);

export default router;
