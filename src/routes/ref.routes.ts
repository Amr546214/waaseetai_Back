import { Router } from 'express';
import { refController } from '../controllers/ref.controller';

import { apiLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Public click-tracking endpoint (increments real visit counters): rate-limited per IP.
router.get('/:slug', apiLimiter, refController.handleReferralClick);

export default router;
