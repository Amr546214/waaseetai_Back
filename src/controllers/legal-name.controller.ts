import { Request, Response, NextFunction } from 'express';
import { legalNameService } from '../services/legal-name.service';

const ctx = (req: Request) => ({ sessionId: req.user?.sessionId, ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });

/** Owner only: the id always comes from the token. The legal name is private: no-store, and no other route returns it. */
export async function getMyLegalName(req: Request, res: Response, next: NextFunction) {
	try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data: await legalNameService.getView(req.user!.id) }); } catch (e) { next(e); }
}
export async function setMyLegalName(req: Request, res: Response, next: NextFunction) {
	try {
		const r = await legalNameService.set(req.user!.id, req.body?.legalName, ctx(req));
		res.setHeader('Cache-Control', 'no-store');
		res.json({ success: true, message: r.outcome === 'SAVED' ? 'تم حفظ الاسم الحقيقي' : 'لا توجد تغييرات للحفظ', data: r });
	} catch (e) { next(e); }
}
export async function cancelMyLegalNameRequest(req: Request, res: Response, next: NextFunction) {
	try { const r = await legalNameService.cancelPending(req.user!.id, ctx(req)); res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, message: 'تم سحب طلب تعديل الاسم', data: r.view }); } catch (e) { next(e); }
}
