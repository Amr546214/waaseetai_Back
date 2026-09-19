import { Request, Response, NextFunction } from 'express';
import { adminAffiliateRequestsService } from '../services/admin-affiliate-requests.service';

export class AdminAffiliateRequestsController {
	public async listRequests(req: Request, res: Response, next: NextFunction) {
		try {
			const status = req.query.status as string | undefined;
			const data = await adminAffiliateRequestsService.listRequests(status);
			res.status(200).json({ success: true, data });
		} catch (error) {
			next(error);
		}
	}

	public async getRequest(req: Request, res: Response, next: NextFunction) {
		try {
			const data = await adminAffiliateRequestsService.getRequestById(req.params.id as string);
			res.status(200).json({ success: true, data });
		} catch (error) {
			next(error);
		}
	}

	public async approve(req: Request, res: Response, next: NextFunction) {
		try {
			const adminUserId = req.user!.id;
			const data = await adminAffiliateRequestsService.approve(req.params.id as string, adminUserId);
			res.status(200).json({ success: true, data, message: 'تم اعتماد الطلب وتطبيق التعديل' });
		} catch (error) {
			next(error);
		}
	}

	public async reject(req: Request, res: Response, next: NextFunction) {
		try {
			const adminUserId = req.user!.id;
			const { rejectionReason } = req.body || {};
			if (!rejectionReason || typeof rejectionReason !== 'string' || !rejectionReason.trim()) {
				res.status(400).json({ success: false, message: 'سبب الرفض مطلوب' });
				return;
			}
			const data = await adminAffiliateRequestsService.reject(req.params.id as string, adminUserId, rejectionReason.trim());
			res.status(200).json({ success: true, data, message: 'تم رفض الطلب' });
		} catch (error) {
			next(error);
		}
	}
}

export const adminAffiliateRequestsController = new AdminAffiliateRequestsController();
