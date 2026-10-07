import crypto from 'crypto';
import { LogCategory, LogStatus, OtpType } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { OtpPurpose, OTP_MAX_ATTEMPTS, OTP_LOCKED_MESSAGE } from '../utils/otp-purpose';
import { otpSendThrottle, otpThrottleMessage } from '../utils/otp-send-throttle';
import { PAYPAL_EMAIL_OTP_REQUIRED_MESSAGE, PAYPAL_EMAIL_FROZEN_MESSAGE } from '../utils/paypal-email-messages';
import { parsePaypalPayoutEmail } from '../dtos/profile.dto';
import { notificationService } from './notification.service';

// Finance #33 — the provider's PayPal payout email changes only with a code sent to the ACCOUNT email, and after a change PayPal
// withdrawals are frozen for 24 hours. No schema change: the pending address lives in the OTP row's JSON context
// ({ purpose: PAYPAL_EMAIL_CHANGE, newEmail }) and the freeze is read from the audit-log row written in the same transaction as the change.
export { PAYPAL_EMAIL_OTP_REQUIRED_MESSAGE, PAYPAL_EMAIL_FROZEN_MESSAGE };
const PAYPAL_EMAIL_SAME_MESSAGE = 'هذا هو بريد PayPal الحالي بالفعل';
const PAYPAL_EMAIL_INVALID_CODE_MESSAGE = 'رمز التحقق غير صحيح';
const PAYPAL_EMAIL_EXPIRED_MESSAGE = 'انتهت صلاحية رمز التحقق أو لا يوجد طلب تغيير، اطلب رمزًا جديدًا';
export const PAYPAL_EMAIL_CHANGE_EXPIRY_MS = 10 * 60 * 1000;
export const PAYPAL_EMAIL_FREEZE_MS = 24 * 60 * 60 * 1000;
export const PAYPAL_EMAIL_CHANGED_EVENT = 'PAYPAL_EMAIL_CHANGED';

const purposeWhere = { path: ['purpose'], equals: OtpPurpose.PAYPAL_EMAIL_CHANGE } as const;
const maskEmail = (email: string) => { const [n = '', d = ''] = email.split('@'); return `${n.slice(0, 2)}***@${d}`; };

export class PaypalEmailChangeService {
	/** Step 1: validate the new address and e-mail a code to the account email; the pending address is kept in the OTP row. */
	async requestChange(userId: string, rawEmail: unknown, ipAddress?: string) {
		const newEmail = parsePaypalPayoutEmail(rawEmail);
		if (!newEmail) throw new AppError('بريد PayPal غير صحيح', 400);
		const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
		if (!user) throw new AppError('حساب المستخدم غير موجود', 404);
		const profile = await prisma.providerProfile.findUnique({ where: { userId }, select: { paypalPayoutEmail: true } });
		if (profile?.paypalPayoutEmail && profile.paypalPayoutEmail.trim().toLowerCase() === newEmail) throw new AppError(PAYPAL_EMAIL_SAME_MESSAGE, 400);

		const throttle = otpSendThrottle.consume(`paypal-change:${userId}`, ipAddress);
		if (!throttle.allowed) throw new AppError(otpThrottleMessage(throttle.reason!, throttle.retryAfterSeconds), 429);

		await prisma.otpVerification.deleteMany({ where: { userId, type: OtpType.EMAIL, context: purposeWhere } });
		const code = crypto.randomInt(100000, 1000000).toString();
		await prisma.otpVerification.create({
			data: { userId, code, type: OtpType.EMAIL, expiresAt: new Date(Date.now() + PAYPAL_EMAIL_CHANGE_EXPIRY_MS), context: { purpose: OtpPurpose.PAYPAL_EMAIL_CHANGE, newEmail } }
		});

		let emailSent = true;
		try {
			await notificationService.sendPaypalEmailChangeOtpEmail(user.email, code);
		} catch {
			emailSent = false;
			logger.error('[PaypalEmailChange] The confirmation email was NOT delivered.');
			await prisma.otpVerification.deleteMany({ where: { userId, type: OtpType.EMAIL, context: purposeWhere } });
		}
		return { emailSent, emailHint: maskEmail(user.email), expiresInSeconds: PAYPAL_EMAIL_CHANGE_EXPIRY_MS / 1000 };
	}

	/** Step 2: the right code writes the pending address, and the same transaction records the change that starts the 24-hour freeze. */
	async confirmChange(userId: string, code: string) {
		const otp = await prisma.otpVerification.findFirst({ where: { userId, type: OtpType.EMAIL, context: purposeWhere }, orderBy: { createdAt: 'desc' } });
		const newEmail = (otp?.context as { newEmail?: unknown } | null)?.newEmail;
		if (!otp || typeof newEmail !== 'string') throw new AppError(PAYPAL_EMAIL_EXPIRED_MESSAGE, 400);
		if (otp.expiresAt <= new Date()) {
			await prisma.otpVerification.delete({ where: { id: otp.id } });
			throw new AppError(PAYPAL_EMAIL_EXPIRED_MESSAGE, 400);
		}
		if (otp.attempts >= OTP_MAX_ATTEMPTS) {
			await prisma.otpVerification.delete({ where: { id: otp.id } });
			throw new AppError(OTP_LOCKED_MESSAGE, 429);
		}
		if (otp.code !== code) {
			const attempts = otp.attempts + 1;
			if (attempts >= OTP_MAX_ATTEMPTS) await prisma.otpVerification.delete({ where: { id: otp.id } });
			else await prisma.otpVerification.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
			throw new AppError(attempts >= OTP_MAX_ATTEMPTS ? OTP_LOCKED_MESSAGE : PAYPAL_EMAIL_INVALID_CODE_MESSAGE, attempts >= OTP_MAX_ATTEMPTS ? 429 : 400);
		}

		await prisma.$transaction(async (tx) => {
			await tx.providerProfile.upsert({ where: { userId }, create: { userId, paypalPayoutEmail: newEmail }, update: { paypalPayoutEmail: newEmail } });
			await tx.otpVerification.delete({ where: { id: otp.id } });
			await tx.accountAuditLog.create({ data: {
				userId, category: LogCategory.SECURITY_CHANGE, title: 'تغيير بريد PayPal', actionText: 'تم تغيير بريد PayPal بعد التحقق عبر البريد الإلكتروني، وسحب PayPal مجمّد 24 ساعة',
				summary: 'تم تغيير بريد PayPal بعد التحقق عبر البريد الإلكتروني', eventType: PAYPAL_EMAIL_CHANGED_EVENT, source: 'USER', severity: 'WARNING', status: LogStatus.COMPLETED
			} });
		});
		try { await notificationService.createAndEmit({ userId, title: 'تم تغيير بريد PayPal', message: 'تم تغيير بريد PayPal لاستلام المدفوعات، وسحب PayPal مجمّد 24 ساعة. إن لم تكن أنت، تواصل مع الدعم فورًا.', actionUrl: '/' }); } catch { /* the change is already committed */ }
		return { paypalPayoutEmail: newEmail, withdrawalsFrozenUntil: new Date(Date.now() + PAYPAL_EMAIL_FREEZE_MS).toISOString() };
	}

	/** When the 24-hour freeze after the latest confirmed change ends, or null when no change happened in the last 24 hours. */
	async frozenUntil(userId: string, client: { accountAuditLog: { findFirst: (args: any) => Promise<{ occurredAt: Date } | null> } } = prisma): Promise<Date | null> {
		const since = new Date(Date.now() - PAYPAL_EMAIL_FREEZE_MS);
		const last = await client.accountAuditLog.findFirst({
			where: { userId, eventType: PAYPAL_EMAIL_CHANGED_EVENT, occurredAt: { gt: since } },
			orderBy: { occurredAt: 'desc' },
			select: { occurredAt: true }
		});
		return last ? new Date(last.occurredAt.getTime() + PAYPAL_EMAIL_FREEZE_MS) : null;
	}
}

export const paypalEmailChangeService = new PaypalEmailChangeService();
