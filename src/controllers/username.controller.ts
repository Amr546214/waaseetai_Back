import { Request, Response, NextFunction } from 'express';
import { usernameService } from '../services/username.service';

const ctx = (req: Request) => ({ sessionId: req.user?.sessionId, ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });
export async function getMyUsername(req: Request, res: Response, next: NextFunction) {
	try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data: await usernameService.get(req.user!.id) }); } catch (e) { next(e); }
}
export async function setMyUsername(req: Request, res: Response, next: NextFunction) {
	try { res.setHeader('Cache-Control', 'no-store'); const r = await usernameService.set(req.user!.id, req.body?.username, ctx(req)); res.json({ success: true, message: r.changed ? 'تم حفظ اسم المستخدم' : 'لا توجد تغييرات للحفظ', data: r }); } catch (e) { next(e); }
}
