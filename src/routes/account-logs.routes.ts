import { Router } from 'express';
import { accountLogsController } from '../controllers/account-logs.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate, requireActiveUser);
router.get('/', (req, res) => accountLogsController.getUserLogs(req, res));
router.get('/:id', (req, res) => accountLogsController.getUserLog(req, res));

export default router;
