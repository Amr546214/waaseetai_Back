import { Router } from 'express';
import {
  generateAssessmentController,
  submitAssessmentController,
  getAttemptStatusController
} from '../controllers/ai-assessment.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';

const router = Router();

// Apply Authentication & Active User check to AI assessment endpoints
router.use(authenticate, requireActiveUser);

// Dynamic Question Generation
router.post('/generate', generateAssessmentController);

// Assessment Submission & AI Evaluation
router.post('/:attemptId/submit', submitAssessmentController);

// Assessment Attempt Status
router.get('/:attemptId/status', getAttemptStatusController);

export default router;
