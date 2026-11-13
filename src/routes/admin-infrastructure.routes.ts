import { NextFunction, Request, Response, Router } from 'express';
import { infrastructureActions } from '../services/infrastructure-actions.service';
import { AppError } from '../utils/app-error';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { requireOfficialDeployment } from '../middlewares/official-deployment.middleware';
import { adminInfrastructureService as svc } from '../services/admin-infrastructure.service';

/** Super Admin + official environment. External mutations require durable intent, reason, typed confirmation and idempotency. */
const router = Router();
const ok = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => { try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await fn(req) }); } catch (e) { next(e); } };
router.use(authenticate, requireActiveUser, requireOfficialDeployment, requireSuperAdmin);
router.get('/servers', ok(() => svc.servers()));
router.get('/database', ok(() => svc.database()));
router.get('/performance', ok(() => svc.performance()));
router.get('/apis', ok(() => svc.apis()));
router.get('/cdn', ok(() => svc.cdn()));
router.get('/backups', ok(() => svc.backups()));
export { RESTORE_PHRASE } from '../services/infrastructure-actions.service';
router.post('/cdn/purge', ok(req => infrastructureActions.purge(String(req.headers['idempotency-key'] || ''), req.user!.id, req.body, req.ip)));
router.post('/backups/jobs', ok(req => infrastructureActions.submitBackup(String(req.headers['idempotency-key'] || ''), req.user!.id, req.body, req.ip)));
router.get('/backups/jobs/:id', ok(req => infrastructureActions.backupJob(String(req.params.id), req.user!.id)));
// Old clients must not mistake an audit-only request for an executed recovery.
router.post('/backups/restore-request', (_req, _res, next) => next(new AppError('استخدم مهمة الاسترداد المؤكدة إلى قاعدة الاسترداد المنفصلة.', 410)));
export default router;
