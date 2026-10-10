import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { paypalEmailChangeService } from '../services/paypal-email-change.service';

const requestSchema = z.object({ paypalEmail: z.string().trim().min(1, 'بريد PayPal مطلوب').max(254, 'بريد PayPal طويل جدًا') });
const confirmSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام') });

const bad = (res: Response, error: z.ZodError) => res.status(400).json({
	success: false, message: 'بيانات غير صحيحة، يرجى مراجعة الحقول المحددة',
	errors: error.issues.map(i => ({ path: i.path.join('.'), field: i.path.join('.'), message: i.message, code: i.code }))
});

export const paypalEmailChangeController = {
	// POST /api/profiles/paypal-email/change/request { paypalEmail }
	async request(req: Request, res: Response, next: NextFunction) {
		try {
			const parsed = requestSchema.safeParse(req.body ?? {});
			if (!parsed.success) return void bad(res, parsed.error);
			const data = await paypalEmailChangeService.requestChange(req.user!.userId, parsed.data.paypalEmail, req.ip);
			// requestChange throws a controlled error when the mail service did not accept the message, so reaching here means emailSent is true.
			res.status(200).json({ success: true, message: 'أرسلنا رمز التحقق إلى بريد حسابك الإلكتروني', data });
		} catch (error) { next(error); }
	},
	// POST /api/profiles/paypal-email/change/confirm { code }
	async confirm(req: Request, res: Response, next: NextFunction) {
		try {
			const parsed = confirmSchema.safeParse(req.body ?? {});
			if (!parsed.success) return void bad(res, parsed.error);
			const data = await paypalEmailChangeService.confirmChange(req.user!.userId, parsed.data.code);
			res.status(200).json({ success: true, message: 'تم تغيير بريد PayPal، وسحب PayPal مجمّد لمدة 24 ساعة', data });
		} catch (error) { next(error); }
	}
};
