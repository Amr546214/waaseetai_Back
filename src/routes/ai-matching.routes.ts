import { Router } from 'express';
import { getTopMatchingProjects } from '../controllers/ai-matching.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';

const router = Router();

// GET /api/provider/ai-matching-projects -> Top 3 matching projects powered by OpenAI
router.get(
  '/ai-matching-projects',
  authenticate,
  requireActiveUser,
  getTopMatchingProjects
);

export default router;
