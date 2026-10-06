import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { KYC_DOCUMENT_KEYS, createKycAccessLink } from '../services/kyc-document-access.service';

export const accessLinkSchema = z.object({
	document: z.enum(KYC_DOCUMENT_KEYS, { message: 'نوع الوثيقة غير معروف' }),
	userId: z.string().uuid('معرّف المستخدم غير صالح').optional(),
	id: z.string().uuid('معرّف الملف غير صالح').optional(),
	index: z.number().int().min(0).max(19).optional()
}).strict();

export async function createAccessLink(req: Request, res: Response, next: NextFunction) {
	try {
		const parsed = accessLinkSchema.safeParse(req.body ?? {});
		if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'بيانات الطلب غير صالحة' });
		const user = req.user!;
		const data = await createKycAccessLink(
			{ id: user.id, accountType: user.accountType, activeRole: user.activeRole, roles: user.roles },
			parsed.data,
			{ ipAddress: req.ip, device: req.get('user-agent') || undefined, sessionId: user.sessionId }
		);
		res.setHeader('Cache-Control', 'no-store');
		res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
}
