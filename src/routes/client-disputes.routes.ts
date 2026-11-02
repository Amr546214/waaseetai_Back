import { mountCaseAttachments, caseFilesUpload } from './case-attachments.routes';
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
mountCaseAttachments(router, '/:id/attachments', 'dispute', false);
router.get('/:id', getMyDispute);

export default router;
