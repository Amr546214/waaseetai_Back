import { Router } from 'express';
import { AdminUsersController } from '../controllers/admin-users.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Protect all admin-user routes
router.use(authenticate);
router.use(authorize(AccountType.SUPER_ADMIN, AccountType.ADMIN));

router.get('/stats', AdminUsersController.getStats);
router.get('/export-csv', AdminUsersController.exportCsv);
router.get('/', AdminUsersController.getUsers);
router.patch('/:id/status', AdminUsersController.updateUserStatus);

// Only SUPER_ADMIN can delete users (enforced by the controller and middleware)
router.delete('/:id', authorize(AccountType.SUPER_ADMIN), AdminUsersController.deleteUser);

export default router;
