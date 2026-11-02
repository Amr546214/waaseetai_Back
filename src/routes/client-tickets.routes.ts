import { mountCaseAttachments, caseFilesUpload } from './case-attachments.routes';
import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { createTicket, listMyTickets, getMyTicket, replyToTicket, closeMyTicket } from '../controllers/support-ticket.controller';

const router = Router();

router.use(authenticate);
router.use(requireActiveUser);

router.post('/', caseFilesUpload, createTicket);
router.get('/', listMyTickets);
mountCaseAttachments(router, '/:id/attachments', 'ticket', false);
router.get('/:id', getMyTicket);
router.post('/:id/reply', replyToTicket);
router.post('/:id/close', closeMyTicket);

export default router;
