import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminListTickets, adminGetTicket, adminReplyToTicket, adminSetTicketStatus, adminAssignTicket, adminSetTicketPriority, adminAddTicketNote } from '../controllers/support-ticket.controller';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('support.review'));
router.get('/', adminListTickets);
router.get('/:id', adminGetTicket);
router.post('/:id/reply', requirePermission('support.reply'), adminReplyToTicket);
router.patch('/:id/status', requirePermission('support.reply'), adminSetTicketStatus);
router.patch('/:id/priority', requirePermission('support.reply'), adminSetTicketPriority);
router.post('/:id/assign', requirePermission('support.reply'), adminAssignTicket);
router.post('/:id/notes', requirePermission('support.reply'), adminAddTicketNote);
export default router;
