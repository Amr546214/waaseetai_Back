import { NextFunction, Request, Response, Router } from 'express';
import { LogCategory, LogStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { requireOfficialDeployment } from '../middlewares/official-deployment.middleware';
import { adminInfrastructureService as svc } from '../services/admin-infrastructure.service';

/**
 * /api/admin/infrastructure - real measurements for «البنية التقنية». SUPER_ADMIN only and official-deployment only (read and write), like the rest of the operations panel.
 * Reads never change anything. The one sensitive action, a restore REQUEST, needs the exact confirmation phrase and is only RECORDED in the audit log: nothing is restored from here,
 * the operations team performs it out of band (no restore, delete or server change is executed by the application).
 */
const router = Router();
const ok = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => { try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await fn(req) }); } catch (e) { next(e); } };
router.use(authenticate, requireActiveUser, requireOfficialDeployment, requireSuperAdmin);
router.get('/servers', ok(() => svc.servers()));
router.get('/database', ok(() => svc.database()));
router.get('/performance', ok(() => svc.performance()));
router.get('/apis', ok(() => svc.apis()));
router.get('/cdn', ok(() => svc.cdn()));
router.get('/backups', ok(() => svc.backups()));
export const RESTORE_PHRASE = 'أؤكد طلب الاستعادة';
router.post('/backups/restore-request', ok(async req => {
	const file = typeof req.body?.file === 'string' ? req.body.file.trim().slice(0, 200) : ''; const phrase = typeof req.body?.confirmation === 'string' ? req.body.confirmation.trim() : ''; const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
	if (!file || /[\\/]/.test(file)) throw new AppError('اسم ملف النسخة مطلوب.', 400);
	if (reason.length < 10) throw new AppError('سبب الاستعادة (10 أحرف على الأقل) مطلوب.', 400);
	if (phrase !== RESTORE_PHRASE) throw new AppError(`اكتب عبارة التأكيد حرفيًا: «${RESTORE_PHRASE}».`, 400);
	await prisma.accountAuditLog.create({ data: { userId: req.user!.id, category: LogCategory.SYSTEM_AUDIT, title: 'طلب استعادة نسخة احتياطية', actionText: `طلب استعادة النسخة ${file}`, summary: `طلب استعادة النسخة ${file} — لم يُنفَّذ شيء من التطبيق`, eventType: 'BACKUP_RESTORE_REQUESTED', source: 'ADMIN', severity: 'CRITICAL', status: LogStatus.COMPLETED, actorLabel: 'ADMIN', ipAddress: req.ip?.slice(0, 80), metaData: { file, reason } } });
	return { recorded: true, executed: false, note: 'سُجّل الطلب فقط. تنفيذ الاستعادة يتم خارج التطبيق من فريق التشغيل.' };
}));
export default router;
