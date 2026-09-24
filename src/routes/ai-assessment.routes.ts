import { Router } from 'express';
import {
  generateAssessmentController,
  submitAssessmentController,
  getAttemptStatusController
} from '../controllers/ai-assessment.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Apply Authentication & Active User check to AI assessment endpoints
router.use(
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)
);

// Dynamic Question Generation
router.post('/generate', aiLimiter, generateAssessmentController);

// Assessment Submission & AI Evaluation
router.post('/:attemptId/submit', aiLimiter, submitAssessmentController);

// Assessment Attempt Status
router.get('/:attemptId/status', getAttemptStatusController);

export default router;
