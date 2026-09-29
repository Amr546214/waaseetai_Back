import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { createTicket, listMyTickets, getMyTicket, replyToTicket, closeMyTicket } from '../controllers/support-ticket.controller';

const router = Router();

router.use(authenticate);
router.use(requireActiveUser);

router.post('/', createTicket);
router.get('/', listMyTickets);
router.get('/:id', getMyTicket);
router.post('/:id/reply', replyToTicket);
router.post('/:id/close', closeMyTicket);

export default router;
