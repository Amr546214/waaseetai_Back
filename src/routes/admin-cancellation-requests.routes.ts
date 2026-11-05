import { Router } from 'express';
import { authenticate, authorizeAdminActing, requireActiveUser } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/admin-access.middleware';
import { adminCancellationController } from '../controllers/contract-cancellation.controller';

// Reading needs disputes.view. The settlement moves money from the HELD escrow, so (like POST /admin/disputes/:id/resolve-financial) it needs BOTH disputes.resolve and payouts.send, on the ACTING role.
const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('disputes.view'));
router.get('/', adminCancellationController.list);
router.get('/:id', adminCancellationController.get);
router.post('/:id/settle', requirePermission('disputes.resolve', 'payouts.send'), authorizeAdminActing, adminCancellationController.settle);
export default router;
