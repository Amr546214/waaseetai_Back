import { Router, Request, Response, NextFunction } from 'express';
import { AccountType, ContractStatus, ProjectStatus } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminOperationsService } from '../services/admin-operations.service';
import { AppError } from '../utils/app-error';
import { requirePermission, requireSuperAdmin, requireOperationScope } from '../middlewares/admin-access.middleware';

const wrap = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};
const enumOf = <T extends Record<string, string>>(values: T, raw: unknown, message: string): T[keyof T] | undefined => {
	if (!raw) return undefined;
	const upper = String(raw).toUpperCase();
	if (!Object.values(values).includes(upper)) throw new AppError(message, 400);
	return upper as T[keyof T];
};

// Projects, contracts and their escrow, READ-ONLY: refund / hold / manual release are not defined by the fee policy and are intentionally not exposed.
export const adminProjectsRouter = Router();
adminProjectsRouter.use(authenticate, requireActiveUser);
adminProjectsRouter.get('/', requireSuperAdmin, wrap(req => adminOperationsService.listProjects({ status: enumOf(ProjectStatus, req.query.status, 'حالة المشروع غير صحيحة'), q: req.query.q ? String(req.query.q) : undefined }, Number(req.query.page) || 1, Number(req.query.limit) || 20)));
adminProjectsRouter.get('/:id', requireOperationScope('PROJECT'), wrap(req => adminOperationsService.getProject(String(req.params.id))));

export const adminContractsRouter = Router();
adminContractsRouter.use(authenticate, requireActiveUser);
adminContractsRouter.get('/', requireSuperAdmin, wrap(req => adminOperationsService.listContracts({ status: enumOf(ContractStatus, req.query.status, 'حالة العقد غير صحيحة'), q: req.query.q ? String(req.query.q) : undefined }, Number(req.query.page) || 1, Number(req.query.limit) || 20)));
adminContractsRouter.get('/:id', requireOperationScope('CONTRACT'), wrap(req => adminOperationsService.getContract(String(req.params.id))));

// Staff the admin can assign a dispute / ticket to.
export const adminStaffRouter = Router();
adminStaffRouter.use(authenticate, requireActiveUser, requirePermission('team.view'));
adminStaffRouter.get('/', wrap(() => adminOperationsService.listStaff()));
