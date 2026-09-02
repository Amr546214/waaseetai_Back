import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { approveWithdrawal, getWithdrawal, listWithdrawals, rejectWithdrawal } from '../controllers/withdrawal.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', listWithdrawals);
router.get('/:id', getWithdrawal);
router.post('/:id/approve', approveWithdrawal);
router.post('/:id/reject', rejectWithdrawal);
export default router;
