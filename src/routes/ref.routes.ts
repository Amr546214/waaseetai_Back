import { Router } from 'express';
import { refController } from '../controllers/ref.controller';

const router = Router();

router.get('/:slug', refController.handleReferralClick);

export default router;
