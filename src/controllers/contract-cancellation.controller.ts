import { Request, Response, NextFunction } from 'express';
import { contractCancellationService, CancellationViewer } from '../services/contract-cancellation.service';

const uid = (req: Request) => (req.user!.userId || req.user!.id) as string;
const handler = (fn: (req: Request) => Promise<{ status?: number; data: unknown }>) => async (req: Request, res: Response, next: NextFunction) => {
	try { const r = await fn(req); res.status(r.status ?? 200).json({ success: true, data: r.data }); } catch (e) { next(e); }
};

/** One controller per party: the SIDE comes from the router the request came through (clientOnly / providerOnly), never from the body. */
export const cancellationController = (side: CancellationViewer['side']) => {
	const v = (req: Request): CancellationViewer => ({ userId: uid(req), side });
	return {
		list: handler(async req => ({ data: await contractCancellationService.listForContract(v(req), String(req.params.projectId)) })),
		create: handler(async req => {
			const r: any = await contractCancellationService.create(v(req), String(req.params.projectId), { ...(req.body || {}), requestKey: req.body?.requestKey ?? req.header('Idempotency-Key') });
			return { status: r.replayed ? 200 : 201, data: r };
		}),
		respond: handler(async req => ({ data: await contractCancellationService.respond(v(req), String(req.params.id), req.body?.decision, req.body?.responseNote) })),
		withdraw: handler(async req => ({ data: await contractCancellationService.withdraw(v(req), String(req.params.id)) }))
	};
};

export const adminCancellationController = {
	list: handler(async req => ({ data: await contractCancellationService.listForAdmin(typeof req.query.status === 'string' ? req.query.status : undefined, Number(req.query.page) || 1, Number(req.query.limit) || 20) })),
	get: handler(async req => ({ data: await contractCancellationService.getForAdmin(String(req.params.id), uid(req)) })),
	/** Executes the agreed settlement (money + closing). The service re-checks disputes.resolve + payouts.send. */
	settle: handler(async req => ({ data: await contractCancellationService.settle(uid(req), String(req.params.id), { releaseToProvider: req.body?.releaseToProvider, expectedHeldAmount: req.body?.expectedHeldAmount, reason: req.body?.reason }) }))
};
