import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { phoneNumberValue } from '../dtos/profile.dto';
import { phoneChangeService } from '../services/phone-change.service';

const requestSchema = z.object({ phoneNumber: phoneNumberValue });
const confirmSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام') });

const bad = (res: Response, error: z.ZodError) => res.status(400).json({
	success: false, message: 'بيانات غير صحيحة، يرجى مراجعة الحقول المحددة',
	errors: error.issues.map(i => ({ path: i.path.join('.'), field: i.path.join('.'), message: i.message, code: i.code }))
});

export const phoneChangeController = {
	// POST /api/profiles/phone/change/request { phoneNumber }
	async request(req: Request, res: Response, next: NextFunction) {
		try {
			const parsed = requestSchema.safeParse(req.body ?? {});
			if (!parsed.success) return void bad(res, parsed.error);
			const data = await phoneChangeService.requestChange(req.user!.userId, parsed.data.phoneNumber, req.ip);
			res.status(200).json({
				success: true,
				message: data.emailSent ? 'أرسلنا رمز التحقق إلى بريدك الإلكتروني' : 'تعذر إرسال رمز التحقق إلى بريدك الآن، حاول مرة أخرى بعد قليل',
				data
			});
		} catch (error) { next(error); }
	},
	// POST /api/profiles/phone/change/confirm { code }
	async confirm(req: Request, res: Response, next: NextFunction) {
		try {
			const parsed = confirmSchema.safeParse(req.body ?? {});
			if (!parsed.success) return void bad(res, parsed.error);
			const data = await phoneChangeService.confirmChange(req.user!.userId, parsed.data.code, { ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });
			res.status(200).json({ success: true, message: 'تم تغيير رقم الجوال بنجاح', data });
		} catch (error) { next(error); }
	}
};
