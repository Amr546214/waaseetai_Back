import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { identityFieldCheckService } from '../services/identity-field-check.service';
import { AppError } from '../utils/app-error';

const partySchema = z.enum(['CLIENT', 'PROVIDER']);
const userIdSchema = z.string().uuid();

/** Admin (permission identity.review is enforced by the router): the advisory per-field result of the latest ID image. */
export async function adminGetIdentityCheck(req: Request, res: Response, next: NextFunction) {
	try {
		const party = partySchema.safeParse(String(req.query.party ?? '').toUpperCase());
		const userId = userIdSchema.safeParse(req.params.userId);
		if (!party.success) throw new AppError('نوع الحساب مطلوب (CLIENT أو PROVIDER)', 400);
		if (!userId.success) throw new AppError('معرّف المستخدم غير صالح', 400);
		const data = await identityFieldCheckService.getAdminView(userId.data, party.data);
		if (!data) throw new AppError('لا يوجد ملف شخصي لهذا الحساب', 404);
		res.setHeader('Cache-Control', 'no-store');
		res.json({ success: true, data });
	} catch (e) { next(e); }
}

/** Owner: neutral state only, own data (the user id comes from the token, never from the request). */
export async function ownerGetIdentityCheck(req: Request, res: Response, next: NextFunction) {
	try {
		const party = partySchema.safeParse(String(req.query.party ?? '').toUpperCase());
		if (!party.success) throw new AppError('نوع الحساب مطلوب (CLIENT أو PROVIDER)', 400);
		const data = await identityFieldCheckService.getOwnerView(req.user!.id, party.data);
		res.setHeader('Cache-Control', 'no-store');
		res.json({ success: true, data });
	} catch (e) { next(e); }
}
