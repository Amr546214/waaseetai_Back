import { NextFunction, Request, Response, Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminRequestsService } from '../services/admin-requests.service';

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
adminRequestsRouter.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
adminRequestsRouter.get('/', handler(req => adminRequestsService.listRequests(query(req))));
adminRequestsRouter.get('/:id', handler(req => adminRequestsService.getRequest(String(req.params.id))));

export const adminOffersRouter = Router();
adminOffersRouter.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));
adminOffersRouter.get('/', handler(req => adminRequestsService.listOffers(query(req))));
adminOffersRouter.get('/:id', handler(req => adminRequestsService.getOffer(String(req.params.id))));

export default adminRequestsRouter;
