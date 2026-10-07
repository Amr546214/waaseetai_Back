import { Request, Response, NextFunction } from 'express';
import { marketerKycService } from '../services/marketer-kyc.service';
import { AppError } from '../utils/app-error';

const ctx = (req: Request) => ({ ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });

export const marketerKycController = {
	// POST /marketer/profile/kyc-document  (multipart field "file"). The body is never read: identityVerified cannot be sent.
	async upload(req: Request, res: Response, next: NextFunction) {
		try {
			if (!req.file) throw new AppError('ملف PDF أو صورة (JPG / PNG / WEBP) مطلوب', 400);
			const data = await marketerKycService.submitDocument(req.user!.userId, req.file, ctx(req));
			res.status(201).json({ success: true, message: 'تم رفع المستند وإرساله للمراجعة', data });
		} catch (error) { next(error); }
	},
	async status(req: Request, res: Response, next: NextFunction) {
		try { res.json({ success: true, data: await marketerKycService.getStatus(req.user!.userId) }); } catch (error) { next(error); }
	},
	async listPending(req: Request, res: Response, next: NextFunction) {
		try { res.json({ success: true, data: await marketerKycService.listPending(Number(req.query.page) || 1, Number(req.query.limit) || 20) }); } catch (error) { next(error); }
	},
	async approve(req: Request, res: Response, next: NextFunction) {
		try { res.json({ success: true, message: 'تم اعتماد هوية الوسيط', data: await marketerKycService.approve(String(req.params.id), req.user!.userId, ctx(req)) }); } catch (error) { next(error); }
	},
	async reject(req: Request, res: Response, next: NextFunction) {
		try { res.json({ success: true, message: 'تم رفض مستند الوسيط', data: await marketerKycService.reject(String(req.params.id), req.user!.userId, req.body?.reason, ctx(req)) }); } catch (error) { next(error); }
	}
};
