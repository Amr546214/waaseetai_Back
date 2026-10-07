import { NotificationCategory, Notification } from '@prisma/client';
import { mailTransporter, getOtpEmailTemplate, getPasswordResetEmailTemplate } from '../utils/mail.transporter';
import { prisma } from '../config/db';
import { getIO } from '../socket';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';

/** What the SMTP server said about one delivery (never contains the code). */
export interface EmailDeliveryResult {
	messageId: string | null;
	accepted: string[];
	rejected: string[];
	response: string | null;
}

/** a***@example.com: enough to correlate a log line, not enough to expose the address. */
export const maskEmail = (email: string): string => {
	const [name = '', domain = ''] = String(email).split('@');
	return `${name.slice(0, 1)}***@${domain}`;
};

const SMS_PROVIDER_IMPLEMENTED = false; // sendSmsViaTwilio() is a stub

const asAddresses = (list: unknown): string[] => (Array.isArray(list) ? list.map(a => String((a as { address?: string })?.address ?? a)) : []);

const logEmailDelivery = (kind: string, to: string, info: any): EmailDeliveryResult => {
	const result: EmailDeliveryResult = {
		messageId: info?.messageId ? String(info.messageId) : null,
		accepted: asAddresses(info?.accepted).map(maskEmail),
		rejected: asAddresses(info?.rejected).map(maskEmail),
		response: info?.response ? String(info.response).slice(0, 200) : null,
	};
	// A recipient the server rejected is a failed delivery even though sendMail resolved.
	const level = result.rejected.length || !result.accepted.length ? 'warn' : 'info';
	logger[level](`[Email:${kind}] to=${maskEmail(to)} messageId=${result.messageId} accepted=${JSON.stringify(result.accepted)} rejected=${JSON.stringify(result.rejected)} response=${JSON.stringify(result.response)}`);
	if (result.rejected.length || !result.accepted.length) throw Object.assign(new Error('SMTP rejected the recipient'), { deliveryResult: result });
	return result;
};

const logEmailFailure = (kind: string, to: string, error: unknown) => {
	const e = error as { code?: string; responseCode?: number; response?: string; message?: string };
	logger.error(`[Email:${kind}] FAILED to=${maskEmail(to)} code=${e?.code ?? 'n/a'} responseCode=${e?.responseCode ?? 'n/a'} response=${JSON.stringify((e?.response ?? e?.message ?? '').toString().slice(0, 200))}`);
};


// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateNotificationInput {
	userId: string;
	title: string;
	message: string;
	category?: NotificationCategory;
	type?: string;
	actionUrl?: string;
	actionText?: string;
	metadata?: Record<string, unknown>;
}

export interface NotificationDto {
	id: string;
	userId: string;
	title: string;
	message: string;
	category: NotificationCategory;
	type: string;
	actionUrl: string | null;
	actionText: string | null;
	isRead: boolean;
	isUnread: boolean;
	createdAt: string; // ISO 8601 — localisation is the frontend's responsibility
	metadata: Record<string, unknown> | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a raw Prisma Notification row into a clean DTO.
 * UI concerns (icons, colours, relative time strings) belong in the frontend.
 */
function toDto(notification: Notification): NotificationDto {
	return {
		id: notification.id,
		userId: notification.userId,
		title: notification.title,
		message: notification.message,
		category: notification.category,
		type: notification.type,
		actionUrl: notification.actionUrl ?? null,
		actionText: notification.actionText ?? null,
		isRead: notification.isRead,
		isUnread: !notification.isRead,
		createdAt: notification.createdAt.toISOString(),
		metadata: (notification.metadata as Record<string, unknown>) ?? null,
	};
}

/**
 * Resolve a raw category query string to a valid NotificationCategory enum
 * value, or return null if the value represents "all categories".
 */
function parseCategoryFilter(raw?: string): NotificationCategory | null {
	if (!raw) return null;

	const upper = raw.toUpperCase() as NotificationCategory;
	const isAll = upper === NotificationCategory.ALL || upper === ('ALL' as string);

	if (isAll) return null;

	const validCategories: string[] = Object.values(NotificationCategory);
	return validCategories.includes(upper) ? (upper as NotificationCategory) : null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class NotificationService {
	private emitDto(dto: NotificationDto): void {
		const io = getIO();
		if (!io) return;
		io.to(`user_${dto.userId}`).to(`project_owner_${dto.userId}`).emit('new_notification', dto);
	}

	/** Broadcast a notification persisted as part of another database transaction. */
	public async emitStored(notificationId: string): Promise<NotificationDto> {
		const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
		if (!notification) throw new Error('Notification not found');
		const dto = toDto(notification);
		this.emitDto(dto);
		return dto;
	}

	/**
	 * Send an OTP verification code via email.
	 */
	public async sendEmailOtp(email: string, code: string): Promise<EmailDeliveryResult> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const emailSubject = process.env.OTP_EMAIL_SUBJECT ?? 'رمز التحقق لتفعيل حسابك - Waseet AI';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';

		try {
			const info = await mailTransporter.sendMail({
				from: `"${senderName}" <${from}>`,
				to: email,
				subject: emailSubject,
				html: getOtpEmailTemplate(code),
			});
			return logEmailDelivery('otp', email, info);
		} catch (error) {
			logEmailFailure('otp', email, error);
			throw error;
		}
	}

	/**
	 * Send a password-reset code via email. Uses its own subject/template
	 * (distinct from the account-activation OTP email) so the two flows never
	 * share wording.
	 */
	public async sendPasswordResetEmail(email: string, firstName: string, code: string): Promise<EmailDeliveryResult> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const emailSubject = process.env.RESET_PASSWORD_EMAIL_SUBJECT ?? 'رمز إعادة تعيين كلمة المرور - Waseet AI';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';

		try {
			const info = await mailTransporter.sendMail({
				from: `"${senderName}" <${from}>`,
				to: email,
				subject: emailSubject,
				html: getPasswordResetEmailTemplate(firstName, code),
			});
			return logEmailDelivery('password-reset', email, info);
		} catch (error) {
			logEmailFailure('password-reset', email, error);
			throw error;
		}
	}

	/** Code that confirms a phone-number change, sent to the ACCOUNT EMAIL (the phone itself is not verified by SMS: it is disabled). */
	public async sendPhoneChangeOtpEmail(email: string, code: string): Promise<EmailDeliveryResult> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const emailSubject = process.env.PHONE_CHANGE_EMAIL_SUBJECT ?? 'رمز تأكيد تغيير رقم الجوال - Waseet AI';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';

		try {
			const info = await mailTransporter.sendMail({ from: `"${senderName}" <${from}>`, to: email, subject: emailSubject, html: getOtpEmailTemplate(code) });
			return logEmailDelivery('phone-change', email, info);
		} catch (error) {
			logEmailFailure('phone-change', email, error);
			throw error;
		}
	}

	/** Code that completes a password login, sent to the ACCOUNT EMAIL (purpose LOGIN_EMAIL; SMS is never used for login). */
	public async sendLoginOtpEmail(email: string, code: string): Promise<EmailDeliveryResult> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const emailSubject = process.env.LOGIN_EMAIL_SUBJECT ?? 'رمز تسجيل الدخول - Waseet AI';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';

		try {
			const info = await mailTransporter.sendMail({ from: `"${senderName}" <${from}>`, to: email, subject: emailSubject, html: getOtpEmailTemplate(code) });
			return logEmailDelivery('login', email, info);
		} catch (error) {
			logEmailFailure('login', email, error);
			throw error;
		}
	}

	/** True only when a real SMS sender exists. Today the only provider code is a Twilio stub, so this is false. */
	public isSmsAvailable(): boolean {
		return process.env.SMS_ENABLED === 'true' && (process.env.SMS_PROVIDER || 'dev') === 'twilio' && SMS_PROVIDER_IMPLEMENTED;
	}

	/**
	 * Send an OTP verification code via SMS.
	 *
	 * No real gateway account exists yet, so with SMS_ENABLED unset/false this
	 * logs the code instead of sending it — the login-time phone OTP flow
	 * (auth.service.ts) can still be tested end-to-end locally/in staging.
	 * In production (NODE_ENV=production) the code is never logged.
	 * Once a provider account exists: set SMS_ENABLED=true, SMS_PROVIDER to a
	 * case below, install its SDK, and implement the matching send*() method.
	 */
	public async sendSmsOtp(phoneNumber: string, code: string): Promise<void> {
		const smsEnabled = process.env.SMS_ENABLED === 'true';
		const smsProvider = process.env.SMS_PROVIDER || 'dev';

		if (!smsEnabled) {
			// Never write the code itself to logs in production — anyone with
			// access to container logs could otherwise log in as the user.
			console.warn('[NotificationService][SMS] SMS is not enabled; no code was sent.');
			return;
		}

		switch (smsProvider) {
			case 'twilio':
				await this.sendSmsViaTwilio(phoneNumber, code);
				break;
			default:
				console.warn(`[NotificationService] Unknown SMS_PROVIDER "${smsProvider}"; no code was sent.`);
		}
	}

	/** Not wired up yet — install the `twilio` SDK and implement this once a Twilio account/credentials exist. */
	private async sendSmsViaTwilio(phoneNumber: string, code: string): Promise<void> {
		console.warn("[NotificationService] SMS_PROVIDER=twilio is set but sendSmsViaTwilio() isn't implemented yet; no code was sent.");
	}

	/**
	 * Fetch paginated notifications for a user, optionally filtered by category.
	 * Returns an empty array if the user does not exist.
	 */
	public async getUserNotifications(
		userId: string,
		categoryFilter?: string,
	): Promise<NotificationDto[]> {
		const category = parseCategoryFilter(categoryFilter);

		const notifications = await prisma.notification.findMany({
			where: {
				userId,
				...(category ? { category } : {}),
			},
			orderBy: { createdAt: 'desc' },
		});

		return notifications.map(toDto);
	}

	/**
	 * Mark a single notification as read.
	 * Emits a real-time `notification_read` event to the owning user.
	 */
	public async markAsRead(notificationId: string, userId: string): Promise<NotificationDto> {
		const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
		if (!notification) throw new AppError('الإشعار غير موجود', 404);

		const updated = await prisma.notification.update({
			where: { id: notification.id },
			data: { isRead: true },
		});

		const io = getIO();
		io?.to(`user_${updated.userId}`).emit('notification_read', { id: notificationId });

		return toDto(updated);
	}

	/**
	 * Mark all unread notifications as read for a user.
	 * Emits a real-time `all_notifications_read` event to the owning user.
	 */
	public async markAllAsRead(userId: string): Promise<void> {
		await prisma.notification.updateMany({
			where: { userId, isRead: false },
			data: { isRead: true },
		});

		const io = getIO();
		io?.to(`user_${userId}`).emit('all_notifications_read', { userId });
	}

	/**
	 * Persist a new notification and broadcast it in real-time via Socket.io.
	 */
	public async createAndEmit(input: CreateNotificationInput): Promise<NotificationDto> {
		const notification = await prisma.notification.create({
			data: {
				userId: input.userId,
				title: input.title,
				message: input.message,
				category: input.category ?? NotificationCategory.ALL,
				type: input.type ?? 'GENERAL',
				actionUrl: input.actionUrl ?? null,
				actionText: input.actionText ?? null,
				metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
				isRead: false,
			},
		});

		const dto = toDto(notification);

		this.emitDto(dto);

		return dto;
	}

	/**
	 * @deprecated Use {@link createAndEmit} instead.
	 * Kept temporarily for backwards-compatibility with existing call sites.
	 */
	public async createAndEmitNotification(
		data: CreateNotificationInput & { category?: string },
	): Promise<NotificationDto> {
		return this.createAndEmit({
			...data,
			category: data.category as NotificationCategory | undefined,
		});
	}
}

export const notificationService = new NotificationService();

// ─── Preferences ──────────────────────────────────────────────────────────────
// One row per user, shared across every role (see schema.prisma's
// NotificationPreference doc comment). A PATCH merges into the existing
// JSON object rather than replacing it wholesale.

export const notificationPreferenceService = {
	async getPreferences(userId: string): Promise<Record<string, boolean>> {
		const row = await prisma.notificationPreference.findUnique({ where: { userId } });
		return (row?.settings as Record<string, boolean>) || {};
	},

	async updatePreferences(userId: string, patch: Record<string, boolean>): Promise<Record<string, boolean>> {
		const existing = await prisma.notificationPreference.findUnique({ where: { userId } });
		const merged = { ...(existing?.settings as Record<string, boolean> | undefined), ...patch };
		const row = await prisma.notificationPreference.upsert({
			where: { userId },
			create: { userId, settings: merged },
			update: { settings: merged },
		});
		return row.settings as Record<string, boolean>;
	},
};
