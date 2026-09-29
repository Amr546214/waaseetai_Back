import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { listMyDisputes, getMyDispute } from '../controllers/dispute.controller';

const router = Router();

// Protect all client dispute endpoints
router.use(authenticate);
router.use(requireActiveUser);

// Client's own disputes — list/detail, scoped to disputes where this
// client is the opener or the respondent (see DisputeService.listForUser).
router.get('/', listMyDisputes);
router.get('/:id', getMyDispute);

export default router;
