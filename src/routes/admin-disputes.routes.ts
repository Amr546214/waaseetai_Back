import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, authorizeAdminActing, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { addAdminDisputeNote, assignAdminDispute, getDispute, setAdminDisputeStatus, getDisputeAiSummary, listDisputes, resolveDispute, resolveDisputeFinancial } from '../controllers/dispute.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', listDisputes);
router.get('/:id', getDispute);
router.post('/:id/resolve', resolveDispute);
// Moves money from the HELD escrow. Admin gate on the ACTING role (an admin account that is acting as a client/provider is refused), on top of the router gate.
router.post('/:id/resolve-financial', authorizeAdminActing, resolveDisputeFinancial);
router.post('/:id/assign', assignAdminDispute);
router.post('/:id/notes', addAdminDisputeNote);
router.patch('/:id/status', setAdminDisputeStatus);
// Advisory-only Gemini summary — read-only, no DB write, never resolves the
// dispute. Admin-only access still gets AI-rate-limited (aiLimiter), same as
// every other Gemini-triggering HTTP route in this codebase.
router.post('/:id/ai-summary', aiLimiter, getDisputeAiSummary);
export default router;
