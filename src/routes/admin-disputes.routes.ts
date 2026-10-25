import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, authorizeAdminActing, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { getDispute, getDisputeAiSummary, listDisputes, resolveDispute } from '../controllers/admin-disputes.controller';
import { addAdminDisputeNote, assignAdminDispute, setAdminDisputeStatus, resolveDisputeFinancial } from '../controllers/dispute.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('disputes.view'));
router.get('/', listDisputes);
router.get('/:id', getDispute);
router.post('/:id/resolve', requirePermission('disputes.resolve'), resolveDispute);
// Moves money from the HELD escrow: needs BOTH disputes.resolve and payouts.send (never an account type), and, and on the ACTING role (an admin account that is acting as a client/provider is refused), on top of the router gate.
router.post('/:id/resolve-financial', requirePermission('disputes.resolve', 'payouts.send'), authorizeAdminActing, resolveDisputeFinancial);
router.post('/:id/assign', requirePermission('disputes.assign'), assignAdminDispute);
router.post('/:id/notes', requirePermission('disputes.note'), addAdminDisputeNote);
router.patch('/:id/status', requirePermission('disputes.resolve'), setAdminDisputeStatus);
// Advisory-only Gemini summary — read-only, no DB write, never resolves the
// dispute. Admin-only access still gets AI-rate-limited (aiLimiter), same as
// every other Gemini-triggering HTTP route in this codebase.
router.post('/:id/ai-summary', aiLimiter, getDisputeAiSummary);
export default router;
