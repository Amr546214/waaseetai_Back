import { NotificationCategory, Notification } from '@prisma/client';
import { mailTransporter, getOtpEmailTemplate, getPasswordResetEmailTemplate } from '../utils/mail.transporter';
import { prisma } from '../config/db';
import { getIO } from '../socket';
import { AppError } from '../utils/app-error';

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
	public async sendEmailOtp(email: string, code: string): Promise<void> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const emailSubject = process.env.OTP_EMAIL_SUBJECT ?? 'رمز التحقق لتفعيل حسابك - Waseet AI';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';

		try {
			await mailTransporter.sendMail({
				from: `"${senderName}" <${from}>`,
				to: email,
				subject: emailSubject,
				html: getOtpEmailTemplate(code),
			});
			console.log(`[NotificationService] OTP email sent to ${email}`);
		} catch (error) {
			console.error(`[NotificationService] Failed to send OTP email to ${email}:`, error);
			throw error;
		}
	}

	/**
	 * Send a password-reset code via email. Uses its own subject/template
	 * (distinct from the account-activation OTP email) so the two flows never
	 * share wording.
	 */
	public async sendPasswordResetEmail(email: string, firstName: string, code: string): Promise<void> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const emailSubject = process.env.RESET_PASSWORD_EMAIL_SUBJECT ?? 'رمز إعادة تعيين كلمة المرور - Waseet AI';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';

		try {
			await mailTransporter.sendMail({
				from: `"${senderName}" <${from}>`,
				to: email,
				subject: emailSubject,
				html: getPasswordResetEmailTemplate(firstName, code),
			});
			console.log(`[NotificationService] Password reset email sent to ${email}`);
		} catch (error) {
			console.error(`[NotificationService] Failed to send password reset email to ${email}:`, error);
			throw error;
		}
	}

	/**
	 * Send an OTP verification code via SMS.
	 * TODO: integrate an SMS gateway (e.g. Twilio, Unifonic).
	 */
	public async sendSmsOtp(phoneNumber: string, code: string): Promise<void> {
		const smsEnabled = process.env.SMS_ENABLED === 'true';
		const smsProvider = process.env.SMS_PROVIDER || 'twilio';
		const smsSenderId = process.env.SMS_SENDER_ID || 'WaseetAI';

		if (!smsEnabled) {
			console.warn(`[NotificationService] SMS disabled. OTP for ${phoneNumber} was NOT sent.`);
			return;
		}

		// Placeholder — wire up a real SMS provider here
		console.warn(`[NotificationService] SMS gateway (${smsProvider}) not implemented. OTP for ${phoneNumber} was NOT sent.`);
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
