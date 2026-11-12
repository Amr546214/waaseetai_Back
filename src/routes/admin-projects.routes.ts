import { Router, Request, Response, NextFunction } from 'express';
import { AccountType, ContractStatus, ProjectStatus } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminOperationsService } from '../services/admin-operations.service';
import { AppError } from '../utils/app-error';
import { requirePermission, requireSuperAdmin, requireOperationScope } from '../middlewares/admin-access.middleware';
import { authorizeAdminActing } from '../middlewares/auth.middleware';
import { adminOrderControls as ctl } from '../controllers/admin-order-controls.controller';

const wrap = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};
const enumOf = <T extends Record<string, string>>(values: T, raw: unknown, message: string): T[keyof T] | undefined => {
	if (!raw) return undefined;
	const upper = String(raw).toUpperCase();
	if (!Object.values(values).includes(upper)) throw new AppError(message, 400);
	return upper as T[keyof T];
};

// Projects, contracts and their escrow. Reads as before; the controls (freeze / unfreeze / cancel / refund / release, 2026-11-12) are below: refund and release are SUPER_ADMIN-only on the server, the others need contracts.manage.
export const adminProjectsRouter = Router();
adminProjectsRouter.use(authenticate, requireActiveUser);
adminProjectsRouter.get('/', requireSuperAdmin, wrap(req => adminOperationsService.listProjects({ status: enumOf(ProjectStatus, req.query.status, 'حالة المشروع غير صحيحة'), q: req.query.q ? String(req.query.q) : undefined }, Number(req.query.page) || 1, Number(req.query.limit) || 20)));
adminProjectsRouter.get('/:id', requireOperationScope('PROJECT'), wrap(req => adminOperationsService.getProject(String(req.params.id))));
adminProjectsRouter.get('/:id/controls', requireOperationScope('PROJECT'), ctl.contractControls);

export const adminContractsRouter = Router();
adminContractsRouter.use(authenticate, requireActiveUser);
adminContractsRouter.get('/', requireSuperAdmin, wrap(req => adminOperationsService.listContracts({ status: enumOf(ContractStatus, req.query.status, 'حالة العقد غير صحيحة'), q: req.query.q ? String(req.query.q) : undefined }, Number(req.query.page) || 1, Number(req.query.limit) || 20)));
adminContractsRouter.get('/:id', requireOperationScope('CONTRACT'), wrap(req => adminOperationsService.getContract(String(req.params.id))));
adminContractsRouter.get('/:id/controls', requireOperationScope('CONTRACT'), ctl.contractControls);
adminContractsRouter.get('/:id/quote', requirePermission('contracts.manage'), ctl.contractQuote);
adminContractsRouter.post('/:id/freeze', requirePermission('contracts.manage'), ctl.freeze);
adminContractsRouter.post('/:id/unfreeze', requirePermission('contracts.manage'), ctl.unfreeze);
adminContractsRouter.post('/:id/cancel', requirePermission('contracts.manage'), authorizeAdminActing, ctl.cancelContract);
adminContractsRouter.post('/:id/refund', requireSuperAdmin, authorizeAdminActing, ctl.refund);
adminContractsRouter.post('/:id/release', requireSuperAdmin, authorizeAdminActing, ctl.release);

// Staff the admin can assign a dispute / ticket to.
export const adminStaffRouter = Router();
adminStaffRouter.use(authenticate, requireActiveUser, requirePermission('team.view'));
adminStaffRouter.get('/', wrap(() => adminOperationsService.listStaff()));
