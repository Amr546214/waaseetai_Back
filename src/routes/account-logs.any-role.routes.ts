import { Router } from 'express';
import { accountLogsController } from '../controllers/account-logs.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';

const router = Router();

// Mounted at /api/account/logs: the signed-in user's OWN activity log, for EVERY role (client, provider, marketer, ...). There is no role or approval gate: the log is scoped to
// req.user.id by the service, so nobody can read another account's entries. (/api/provider/logs stays the provider-gated route for the provider dashboard.)
router.use(authenticate, requireActiveUser);
router.get('/', (req, res) => accountLogsController.getUserLogs(req, res));
router.get('/:id', (req, res) => accountLogsController.getUserLog(req, res));

export default router;
