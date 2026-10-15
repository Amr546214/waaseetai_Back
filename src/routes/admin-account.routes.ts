import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { accountActionLimiter } from '../middlewares/rate-limit.middleware';
import * as c from '../controllers/admin-account.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

// Platform audit trail (real AccountAuditLog) + the real admin roster
router.get('/audit-log', c.getAuditLog);
router.get('/admins', c.getAdmins);
// The admin's own account: profile + sessions (password change: PUT /api/provider/profile/password, identity-level)
router.get('/account/me', c.getMe);
router.patch('/account/me', accountActionLimiter, c.updateMe);
router.get('/account/sessions', c.getSessions);
router.delete('/account/sessions', accountActionLimiter, c.deleteOtherSessions);
router.delete('/account/sessions/:id', accountActionLimiter, c.deleteSession);

export default router;
