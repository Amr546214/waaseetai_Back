import { NextFunction, Request, Response, Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminRequestsService } from '../services/admin-requests.service';
import { requireSuperAdmin, requireOperationScope, requirePermission } from '../middlewares/admin-access.middleware';
import { adminOrderControls as ctl } from '../controllers/admin-order-controls.controller';

const handler = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};
const query = (req: Request) => ({
	status: typeof req.query.status === 'string' ? req.query.status : undefined,
	search: typeof req.query.search === 'string' ? req.query.search : undefined,
	page: Number(req.query.page), limit: Number(req.query.limit)
});

// Read-only admin view of client requests (/admin/requests) and of the offers on them (/admin/offers).
export const adminRequestsRouter = Router();
adminRequestsRouter.use(authenticate, requireActiveUser);
adminRequestsRouter.get('/', requireSuperAdmin, handler(req => adminRequestsService.listRequests(query(req))));
adminRequestsRouter.get('/:id', requireOperationScope('REQUEST'), handler(req => adminRequestsService.getRequest(String(req.params.id))));
// Controls (2026-11-12): availability with stable reason codes, the cancel quote, and the three actions. All need requests.manage on the server (a SUPER_ADMIN holds every permission); a cancel that
// touches a contract also needs contracts.manage, and one that moves held money is SUPER_ADMIN-only: both are decided in the service from the same rule table the controls read model uses.
adminRequestsRouter.get('/:id/controls', requireOperationScope('REQUEST'), ctl.requestControls);
adminRequestsRouter.get('/:id/cancel-quote', requirePermission('requests.manage'), ctl.requestCancelQuote);
adminRequestsRouter.post('/:id/suspend', requirePermission('requests.manage'), ctl.suspendRequest);
adminRequestsRouter.post('/:id/resume', requirePermission('requests.manage'), ctl.resumeRequest);
adminRequestsRouter.post('/:id/cancel', requirePermission('requests.manage'), ctl.cancelRequest);

export const adminOffersRouter = Router();
adminOffersRouter.use(authenticate, requireActiveUser);
adminOffersRouter.get('/', requireSuperAdmin, handler(req => adminRequestsService.listOffers(query(req))));
adminOffersRouter.get('/:id', requireOperationScope('OFFER'), handler(req => adminRequestsService.getOffer(String(req.params.id))));
adminOffersRouter.get('/:id/controls', requireOperationScope('OFFER'), ctl.offerControls);
adminOffersRouter.post('/:id/suspend', requirePermission('offers.manage'), ctl.suspendOffer);
adminOffersRouter.post('/:id/resume', requirePermission('offers.manage'), ctl.resumeOffer);

export default adminRequestsRouter;
