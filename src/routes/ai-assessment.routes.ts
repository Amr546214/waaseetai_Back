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
import { requireExamEnvironment, examEnvironmentStatus } from '../middlewares/exam-environment.middleware';
import { getActiveAttempt, saveAttemptAnswers, logAttemptEvent } from '../controllers/exam-attempt.controller';
import { apiLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Apply Authentication & Active User check to AI assessment endpoints
router.use(
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)
);

// Which exam mode the server runs and whether THIS request came from a verified Safe Exam Browser (never reveals a key).
router.get('/exam-environment', examEnvironmentStatus);

// In restricted mode (EXAM_SEB_MODE=required) every route below needs a verified Safe Exam Browser request; in the default mode nothing changes.
// Dynamic Question Generation
router.post('/generate', requireExamEnvironment, aiLimiter, generateAssessmentController);

// Resume a live attempt after a reload / reconnect: key-less questions, saved answers, the server's remaining time.
router.get('/active', requireExamEnvironment, apiLimiter, getActiveAttempt);
// Silent autosave of the answers so far, and page / exam-mode events for reviewers (information only: never a score or a failure).
router.put('/:attemptId/answers', requireExamEnvironment, apiLimiter, saveAttemptAnswers);
router.post('/:attemptId/events', requireExamEnvironment, apiLimiter, logAttemptEvent);

// Assessment Submission & AI Evaluation
router.post('/:attemptId/submit', requireExamEnvironment, aiLimiter, submitAssessmentController);

// Assessment Attempt Status
router.get('/:attemptId/status', getAttemptStatusController);

export default router;
