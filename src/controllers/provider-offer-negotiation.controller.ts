import { Request, Response, NextFunction } from 'express';
import { providerOfferNegotiationService as svc } from '../services/provider-offer-negotiation.service';

const uid = (req: Request) => req.user!.userId || req.user!.id;

// Provider-only (route guard) negotiation actions on the provider's OWN offers; the provider id comes from the token, never from the body.
export const providerOfferNegotiationController = {
	async viewByOffer(req: Request, res: Response, next: NextFunction) {
		try { res.status(200).json({ success: true, data: await svc.getView(uid(req), { offerId: req.params.id as string }) }); } catch (e) { next(e); }
	},
	async viewByProject(req: Request, res: Response, next: NextFunction) {
		try { res.status(200).json({ success: true, data: await svc.getView(uid(req), { projectId: req.params.projectId as string }) }); } catch (e) { next(e); }
	},
	async withdraw(req: Request, res: Response, next: NextFunction) {
		try { res.status(200).json({ success: true, message: 'تم سحب العرض', data: await svc.withdraw(uid(req), req.params.id as string) }); } catch (e) { next(e); }
	},
	async counter(req: Request, res: Response, next: NextFunction) {
		try { res.status(201).json({ success: true, message: 'تم إرسال العرض المضاد وهو بانتظار رد العميل', data: await svc.counter(uid(req), req.params.id as string, req.body || {}) }); } catch (e) { next(e); }
	},
	async reject(req: Request, res: Response, next: NextFunction) {
		try { res.status(200).json({ success: true, message: 'تم الرد على طلب التفاوض، ويبقى العرض بشروطه الأصلية', data: await svc.reject(uid(req), req.params.id as string, req.body || {}) }); } catch (e) { next(e); }
	}
};
