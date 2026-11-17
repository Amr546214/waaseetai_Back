import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, requireActiveUser, authorizeActiveRole } from '../middlewares/auth.middleware';
import { requireClientCompanyAccount } from './client-company-team.routes';
import { getClientCompanyDashboard } from '../services/client-company-dashboard.service';

const router = Router();
router.get('/dashboard', authenticate, requireActiveUser, authorizeActiveRole(AccountType.CLIENT_COMPANY), requireClientCompanyAccount, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    const userId = req.user?.id || req.user?.userId;
    res.json({ success: true, data: await getClientCompanyDashboard(userId!) });
  } catch (error) { next(error); }
});
export default router;
