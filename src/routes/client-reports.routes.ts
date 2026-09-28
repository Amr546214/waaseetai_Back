import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { clientReportsController } from '../controllers/client-reports.controller';

const router = Router();

router.get('/', authenticate, requireActiveUser, clientReportsController.getReports);

export default router;
