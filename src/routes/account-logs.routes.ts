import { requireApprovedProvider } from '../middlewares/provider-access.middleware';
import { Router } from 'express';
import { accountLogsController } from '../controllers/account-logs.controller';
import { AccountType } from '@prisma/client';
import { authenticate, requireActiveUser, authorizeActiveRole } from '../middlewares/auth.middleware';

const router = Router();

// Mounted ONLY at /api/provider/logs: operational, an unapproved individual provider gets 403.
router.use(authenticate, requireActiveUser, authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY), requireApprovedProvider);
router.get('/', (req, res) => accountLogsController.getUserLogs(req, res));
router.get('/:id', (req, res) => accountLogsController.getUserLog(req, res));

export default router;
