import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminListTickets, adminGetTicket, adminReplyToTicket, adminSetTicketStatus } from '../controllers/support-ticket.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', adminListTickets);
router.get('/:id', adminGetTicket);
router.post('/:id/reply', adminReplyToTicket);
router.patch('/:id/status', adminSetTicketStatus);
export default router;
