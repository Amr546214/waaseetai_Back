import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { getSecurityEvents, getFlaggedAccounts } from '../controllers/admin-security.controller';
import { requirePermission, requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { LogCategory, LogStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { requireOfficialDeployment } from '../middlewares/official-deployment.middleware';
import { loginGuardService } from '../services/login-guard.service';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('audit.view'));

// Deterministic — reads AccountAuditLog/User/Dispute only, no Gemini call,
// so apiLimiter (applied globally) is sufficient; no aiLimiter needed.
router.get('/events', getSecurityEvents);
router.get('/flagged-accounts', getFlaggedAccounts);

// Login blocks: the list and the lift are SUPER_ADMIN only (checked on the server from the database, not from anything the browser sends); every lift is audited.
router.get('/login-blocks', requireOfficialDeployment, requireSuperAdmin, async (_req, res, next) => { try { res.json({ success: true, data: await loginGuardService.listBlocks() }); } catch (e) { next(e); } });
router.post('/login-blocks/unblock', requireOfficialDeployment, requireSuperAdmin, async (req, res, next) => {
	try {
		const id = typeof req.body?.id === 'string' ? req.body.id : ''; if (!/^(p:.+\|[0-9a-f]{32}|i:.+|a:[0-9a-f]{32})$/.test(id)) throw new AppError('معرّف الحظر غير صالح', 400);
		const done = await loginGuardService.unblock(id, req.user!.id, req.ip); if (!done) throw new AppError('لا يوجد حظر فعّال بهذا المعرّف', 404);

		res.json({ success: true, data: { unblocked: true } });
	} catch (e) { next(e); }
});

export default router;
