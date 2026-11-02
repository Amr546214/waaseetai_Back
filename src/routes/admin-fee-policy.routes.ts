import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireAnyPermission, requirePermission } from '../middlewares/admin-access.middleware';
import { feePolicyService } from '../services/fee-policy.service';

/**
 * /api/admin/fee-policy - versioned financial terms. Reading needs `fees.view` (or `fees.manage`); scheduling or cancelling needs `fees.manage` (SUPER_ADMIN holds every permission).
 * Versions are immutable: there is no edit route, only "schedule a newer version" and "cancel one that has not taken effect yet".
 */
const router = Router();
const ok = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.status(status).json({ success: true, data: await fn(req) }); } catch (e) { next(e); }
};
const ctx = (req: Request) => ({ ip: req.ip, device: String(req.headers['user-agent'] || '') });
router.use(authenticate, requireActiveUser, requireAnyPermission('fees.view', 'fees.manage'));
router.get('/', ok(() => feePolicyService.view()));
router.post('/', requirePermission('fees.manage'), ok(req => feePolicyService.schedule(req.user!.id, req.body, ctx(req)), 201));
router.post('/:id/cancel', requirePermission('fees.manage'), ok(req => feePolicyService.cancel(req.user!.id, String(req.params.id), ctx(req))));
export default router;
