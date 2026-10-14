import { Router } from 'express';
import { AdminUsersController } from '../controllers/admin-users.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Protect all admin-user routes
router.use(authenticate, requireActiveUser);
router.use(authorize(AccountType.SUPER_ADMIN, AccountType.ADMIN));

router.get('/stats', AdminUsersController.getStats);
router.get('/export-csv', AdminUsersController.exportCsv);
router.get('/roles-overview', AdminUsersController.getRolesOverview);
router.get('/provider-levels', AdminUsersController.getProviderLevels);
router.get('/', AdminUsersController.getUsers);
router.get('/:id', AdminUsersController.getUserDetail);
router.get('/:id/audit-log', AdminUsersController.getUserAuditLog);
router.patch('/:id/status', AdminUsersController.updateUserStatus);
router.patch('/:id/roles', AdminUsersController.updateUserRoles);
router.post('/:id/notify', AdminUsersController.notifyUser);

// Only SUPER_ADMIN can delete users (enforced by the controller and middleware)
router.delete('/:id', authorize(AccountType.SUPER_ADMIN), AdminUsersController.deleteUser);

export default router;
