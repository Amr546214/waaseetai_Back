import crypto from 'crypto';
import { LogCategory, OtpType } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { OtpPurpose, OTP_MAX_ATTEMPTS, OTP_LOCKED_MESSAGE } from '../utils/otp-purpose';
import { otpSendThrottle, otpThrottleMessage } from '../utils/otp-send-throttle';
import { notificationService } from './notification.service';
import { accountAuditLogService, AuditContext } from './account-logs.service';

// AUD-FND-000026 — changing the phone number needs a code sent to the ACCOUNT EMAIL (SMS is disabled). No schema change: the pending number
// lives in the existing OTP row's JSON context ({ purpose: PHONE_CHANGE, newPhone }).
import { PHONE_CHANGE_REQUIRED_MESSAGE, PHONE_CHANGE_SAME_NUMBER_MESSAGE, PHONE_CHANGE_INVALID_CODE_MESSAGE, PHONE_CHANGE_EXPIRED_MESSAGE, PHONE_CHANGE_GENERIC_CONFLICT } from '../utils/phone-change-messages';
export { PHONE_CHANGE_REQUIRED_MESSAGE, PHONE_CHANGE_SAME_NUMBER_MESSAGE, PHONE_CHANGE_INVALID_CODE_MESSAGE, PHONE_CHANGE_EXPIRED_MESSAGE, PHONE_CHANGE_GENERIC_CONFLICT };
export const PHONE_CHANGE_EXPIRY_MS = 10 * 60 * 1000;

const maskEmail = (email: string) => { const [n = '', d = ''] = email.split('@'); return `${n.slice(0, 2)}***@${d}`; };
const maskPhone = (p: string | null | undefined) => (p ? `${'*'.repeat(Math.max(0, p.length - 3))}${p.slice(-3)}` : null);
const purposeWhere = { path: ['purpose'], equals: OtpPurpose.PHONE_CHANGE } as const;

export class PhoneChangeService {
	/** Step 1: validate the number (done by the schema), send a code to the account email. The answer is identical whether or not the number belongs to someone else. */
	async requestChange(userId: string, newPhone: string, ipAddress?: string) {
		const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, phoneNumber: true } });
		if (!user) throw new AppError('حساب المستخدم غير موجود', 404);
		if (user.phoneNumber && user.phoneNumber === newPhone) throw new AppError(PHONE_CHANGE_SAME_NUMBER_MESSAGE, 400);

		const throttle = otpSendThrottle.consume(`phone-change:${userId}`, ipAddress);
		if (!throttle.allowed) throw new AppError(otpThrottleMessage(throttle.reason!, throttle.retryAfterSeconds), 429);

		// one live code per user: a new request replaces the previous one (the newest code wins)
		await prisma.otpVerification.deleteMany({ where: { userId, type: OtpType.EMAIL, context: purposeWhere } });
		const code = crypto.randomInt(100000, 1000000).toString();
		await prisma.otpVerification.create({
			data: { userId, code, type: OtpType.EMAIL, expiresAt: new Date(Date.now() + PHONE_CHANGE_EXPIRY_MS), context: { purpose: OtpPurpose.PHONE_CHANGE, newPhone } }
		});

		let emailSent = true;
		try {
			await notificationService.sendPhoneChangeOtpEmail(user.email, code);
		} catch {
			emailSent = false;
			logger.error('[PhoneChange] The confirmation email was NOT delivered.');
			// nothing was sent: the unusable code is removed so it cannot be guessed blind
			await prisma.otpVerification.deleteMany({ where: { userId, type: OtpType.EMAIL, context: purposeWhere } });
		}
		return { emailSent, emailHint: maskEmail(user.email), expiresInSeconds: PHONE_CHANGE_EXPIRY_MS / 1000 };
	}

	/** Step 2: the code applies the pending number. */
	async confirmChange(userId: string, code: string, context?: AuditContext) {
		const otp = await prisma.otpVerification.findFirst({ where: { userId, type: OtpType.EMAIL, context: purposeWhere }, orderBy: { createdAt: 'desc' } });
		const newPhone = (otp?.context as { newPhone?: unknown } | null)?.newPhone;
		if (!otp || typeof newPhone !== 'string') throw new AppError(PHONE_CHANGE_EXPIRED_MESSAGE, 400);
		if (otp.expiresAt <= new Date()) {
			await prisma.otpVerification.delete({ where: { id: otp.id } });
			throw new AppError(PHONE_CHANGE_EXPIRED_MESSAGE, 400);
		}
		if (otp.attempts >= OTP_MAX_ATTEMPTS) {
			await prisma.otpVerification.delete({ where: { id: otp.id } });
			throw new AppError(OTP_LOCKED_MESSAGE, 429);
		}
		if (otp.code !== code) {
			const attempts = otp.attempts + 1;
			if (attempts >= OTP_MAX_ATTEMPTS) await prisma.otpVerification.delete({ where: { id: otp.id } });
			else await prisma.otpVerification.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
			await accountAuditLogService.record({ userId, eventType: 'PHONE_CHANGE_REJECTED', category: LogCategory.SECURITY_CHANGE, title: 'تأكيد تغيير رقم الجوال', summary: 'فشلت محاولة تأكيد تغيير رقم الجوال لأن الرمز غير صحيح', source: 'USER', severity: 'WARNING', status: 'REJECTED', context });
			throw new AppError(attempts >= OTP_MAX_ATTEMPTS ? OTP_LOCKED_MESSAGE : PHONE_CHANGE_INVALID_CODE_MESSAGE, attempts >= OTP_MAX_ATTEMPTS ? 429 : 400);
		}

		const before = await prisma.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } });
		try {
			await prisma.$transaction(async (tx) => {
				await tx.user.update({ where: { id: userId }, data: { phoneNumber: newPhone } });
				await tx.otpVerification.delete({ where: { id: otp.id } });
			});
		} catch (error) {
			// unique phone: the code is spent (no probing), and the message does not reveal that the number belongs to someone else
			if ((error as { code?: string })?.code === 'P2002') {
				await prisma.otpVerification.deleteMany({ where: { userId, type: OtpType.EMAIL, context: purposeWhere } });
				throw new AppError(PHONE_CHANGE_GENERIC_CONFLICT, 409);
			}
			throw error;
		}
		await accountAuditLogService.record({ userId, eventType: 'PHONE_CHANGED', category: LogCategory.SECURITY_CHANGE, title: 'تغيير رقم الجوال', summary: 'تم تغيير رقم الجوال بعد التحقق عبر البريد الإلكتروني', source: 'USER', before: { phoneNumber: maskPhone(before?.phoneNumber) }, after: { phoneNumber: maskPhone(newPhone) }, context });
		try { await notificationService.createAndEmit({ userId, title: 'تم تغيير رقم الجوال', message: 'تم تغيير رقم جوال حسابك. إن لم تكن أنت، تواصل مع الدعم فورًا.', actionUrl: '/' }); } catch { /* the change is already committed */ }
		return { phoneNumber: newPhone };
	}
}

export const phoneChangeService = new PhoneChangeService();
