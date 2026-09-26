import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { getSecurityEvents, getFlaggedAccounts } from '../controllers/admin-security.controller';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

// Deterministic — reads AccountAuditLog/User/Dispute only, no Gemini call,
// so apiLimiter (applied globally) is sufficient; no aiLimiter needed.
router.get('/events', getSecurityEvents);
router.get('/flagged-accounts', getFlaggedAccounts);

export default router;
