import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/admin-access.middleware';
import { adminCancellationController } from '../controllers/contract-cancellation.controller';

// READ-ONLY on purpose: who in the administration approves a mutual cancellation, and what happens to the money, is not decided yet (docs/proposals/mutual-cancellation.md).
const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('disputes.view'));
router.get('/', adminCancellationController.list);
router.get('/:id', adminCancellationController.get);
export default router;
