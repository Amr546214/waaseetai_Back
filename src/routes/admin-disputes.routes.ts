import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { addAdminDisputeNote, assignAdminDispute, getDispute, setAdminDisputeStatus, getDisputeAiSummary, listDisputes, resolveDispute } from '../controllers/dispute.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', listDisputes);
router.get('/:id', getDispute);
router.post('/:id/resolve', resolveDispute);
router.post('/:id/assign', assignAdminDispute);
router.post('/:id/notes', addAdminDisputeNote);
router.patch('/:id/status', setAdminDisputeStatus);
// Advisory-only Gemini summary — read-only, no DB write, never resolves the
// dispute. Admin-only access still gets AI-rate-limited (aiLimiter), same as
// every other Gemini-triggering HTTP route in this codebase.
router.post('/:id/ai-summary', aiLimiter, getDisputeAiSummary);
export default router;
