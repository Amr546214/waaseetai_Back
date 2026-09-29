import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { approveWithdrawal, getWithdrawal, listWithdrawals, rejectWithdrawal, sendWithdrawalPayout } from '../controllers/withdrawal.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', listWithdrawals);
router.get('/:id', getWithdrawal);
router.post('/:id/approve', approveWithdrawal);
router.post('/:id/reject', rejectWithdrawal);
// Payout P2-C: a deliberately SEPARATE admin action from approve() above —
// approving only decides eligibility, this actually moves money. Same
// authentication/authorization chain as every other route in this router
// (the router.use(...) line above applies to it identically).
router.post('/:id/send-payout', sendWithdrawalPayout);
export default router;
