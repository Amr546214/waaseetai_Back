import { Router } from 'express';
import { AdminUsersController } from '../controllers/admin-users.controller';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';
import { requirePermission, requireSuperAdmin } from '../middlewares/admin-access.middleware';

const router = Router();

// Protect all admin-user routes
router.use(authenticate, requireActiveUser);
router.use(requirePermission('users.view'));

router.get('/stats', AdminUsersController.getStats);
router.get('/export-csv', AdminUsersController.exportCsv);
router.get('/roles-overview', AdminUsersController.getRolesOverview);
router.get('/provider-levels', AdminUsersController.getProviderLevels);
router.get('/', AdminUsersController.getUsers);
router.get('/:id', AdminUsersController.getUserDetail);
router.get('/:id/audit-log', AdminUsersController.getUserAuditLog);
router.patch('/:id/status', requirePermission('users.suspend'), AdminUsersController.updateUserStatus);
router.patch('/:id/roles', requireSuperAdmin, AdminUsersController.updateUserRoles);
router.post('/:id/notify', requirePermission('support.reply'), AdminUsersController.notifyUser);

// Only SUPER_ADMIN can delete users (enforced by the controller and middleware)
router.delete('/:id', requirePermission('users.delete'), AdminUsersController.deleteUser);

export default router;
