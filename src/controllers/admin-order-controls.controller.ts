import { NextFunction, Request, Response } from 'express';
import { loadAdminActor } from '../middlewares/admin-access.middleware';
import { adminOrderControlsService as svc } from '../services/admin-order-controls.service';
import { AppError } from '../utils/app-error';

/** Thin HTTP layer: the actor comes from the database (loadAdminActor), the Idempotency-Key from the header, everything else from the body. No rule lives here (see admin-order-controls.service). */
type Handler = (req: Request, actor: Awaited<ReturnType<typeof loadAdminActor>>) => Promise<unknown>;
const run = (fn: Handler, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
	try { const actor = await loadAdminActor(req); res.status(status).json({ success: true, data: await fn(req, actor) }); } catch (e) { next(e); }
};
const id = (req: Request) => String(req.params.id);
const body = (req: Request) => ({ ...((req.body && typeof req.body === 'object') ? req.body : {}), key: req.header('idempotency-key') });
const quoteAction = (req: Request): 'CANCEL' | 'REFUND' | 'RELEASE' => {
	const a = String(req.query.action ?? '').toUpperCase();
	if (a !== 'CANCEL' && a !== 'REFUND' && a !== 'RELEASE') throw new AppError('نوع الإجراء غير صحيح', 400);
	return a;
};

export const adminOrderControls = {
	requestControls: run((req, a) => svc.requestControls(id(req), a)),
	requestCancelQuote: run((req, a) => svc.quoteRequestCancel(id(req), a)),
	suspendRequest: run((req, a) => svc.suspendRequest(a, id(req), body(req))),
	resumeRequest: run((req, a) => svc.resumeRequest(a, id(req), body(req))),
	cancelRequest: run((req, a) => svc.cancelRequest(a, id(req), body(req))),

	offerControls: run((req, a) => svc.offerControls(id(req), a)),
	suspendOffer: run((req, a) => svc.suspendOffer(a, id(req), body(req))),
	resumeOffer: run((req, a) => svc.resumeOffer(a, id(req), body(req))),

	contractControls: run((req, a) => svc.contractControls(id(req), a)),
	contractQuote: run((req, a) => svc.quoteContract(id(req), quoteAction(req), a)),
	freeze: run((req, a) => svc.freezeContract(a, id(req), body(req))),
	unfreeze: run((req, a) => svc.unfreezeContract(a, id(req), body(req))),
	cancelContract: run((req, a) => svc.cancelContract(a, id(req), body(req))),
	refund: run((req, a) => svc.refundToClient(a, id(req), body(req))),
	release: run((req, a) => svc.releaseToProvider(a, id(req), body(req))),
};
