import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminListTickets, adminGetTicket, adminReplyToTicket, adminSetTicketStatus, adminAssignTicket, adminSetTicketPriority, adminAddTicketNote } from '../controllers/support-ticket.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', adminListTickets);
router.get('/:id', adminGetTicket);
router.post('/:id/reply', adminReplyToTicket);
router.patch('/:id/status', adminSetTicketStatus);
router.patch('/:id/priority', adminSetTicketPriority);
router.post('/:id/assign', adminAssignTicket);
router.post('/:id/notes', adminAddTicketNote);
export default router;
