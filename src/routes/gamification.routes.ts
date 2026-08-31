import { Router } from 'express';
import { gamificationController } from '../controllers/gamification.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.get('/level-details', authenticate, gamificationController.getLevelDetails);

export default router;
