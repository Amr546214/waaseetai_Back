import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { getDispute, listDisputes, resolveDispute } from '../controllers/dispute.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
router.get('/', listDisputes);
router.get('/:id', getDispute);
router.post('/:id/resolve', resolveDispute);
export default router;
