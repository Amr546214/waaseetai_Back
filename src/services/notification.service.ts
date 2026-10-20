import { NotificationCategory, Notification } from '@prisma/client';
import { mailTransporter, getOtpEmailTemplate, getPasswordResetEmailTemplate } from '../utils/mail.transporter';
import { otpValidityText } from '../utils/otp-validity';
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

// No brand name in the subject: a third-party brand in the subject of a message that does not come from that brand is a classic phishing signal for mail providers.
export const PAYMENT_OTP_DEFAULT_SUBJECT = 'رمز التحقق لتأكيد الدفع - Waseet AI';
/** Validity of the payment codes (cart checkout and amendment funding), in minutes. Kept equal to the TTL constants of those services. */
export const PAYMENT_OTP_VALIDITY_MINUTES = 2;
export const PAYPAL_OTP_DEFAULT_SUBJECT = 'رمز التحقق لتأكيد بريد استلام المدفوعات - Waseet AI';

const SMS_PROVIDER_IMPLEMENTED = false; // sendSmsViaTwilio() is a stub

const asAddresses = (list: unknown): string[] => (Array.isArray(list) ? list.map(a => String((a as { address?: string })?.address ?? a)) : []);

const logEmailDelivery = (kind: string, to: string, info: any, ms?: number): EmailDeliveryResult => {
	const result: EmailDeliveryResult = {
		messageId: info?.messageId ? String(info.messageId) : null,
		accepted: asAddresses(info?.accepted).map(maskEmail),
		rejected: asAddresses(info?.rejected).map(maskEmail),
		response: info?.response ? String(info.response).slice(0, 200) : null,
	};
	// A recipient the server rejected is a failed delivery even though sendMail resolved.
	const level = result.rejected.length || !result.accepted.length ? 'warn' : 'info';
	logger[level](`[Email:${kind}] to=${maskEmail(to)} messageId=${result.messageId} accepted=${JSON.stringify(result.accepted)} rejected=${JSON.stringify(result.rejected)} response=${JSON.stringify(result.response)}${ms === undefined ? '' : ` ms=${ms}`}`);
	if (result.rejected.length || !result.accepted.length) throw Object.assign(new Error('SMTP rejected the recipient'), { deliveryResult: result });
	return result;
};

const logEmailFailure = (kind: string, to: string, error: unknown, ms?: number) => {
	const e = error as { code?: string; responseCode?: number; response?: string; message?: string };
	logger.error(`[Email:${kind}] FAILED to=${maskEmail(to)} code=${e?.code ?? 'n/a'} responseCode=${e?.responseCode ?? 'n/a'} response=${JSON.stringify((e?.response ?? e?.message ?? '').toString().slice(0, 200))}${ms === undefined ? '' : ` ms=${ms}`}`);
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

/**
 * A provider's saved notification channels (provider_profiles.preferences.notifChannels, set from the profile page):
 *  - 'push'  = the real-time in-app push (socket). The notification itself is ALWAYS stored and stays in the inbox either way.
 *  - 'email' = an optional e-mail copy of the notification.
 * Nothing saved (or not a provider) keeps today's behaviour: real-time push on, no e-mail.
 */
/** 'en' only when the provider chose English as the communication language; anything else (nothing saved) is Arabic. */
export const resolveCommunicationLanguage = (preferences: unknown): 'ar' | 'en' => {
	const lang = preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? (preferences as Record<string, unknown>).preferredCommunicationLanguage : undefined;
	return lang === 'en' ? 'en' : 'ar';
};

/** The e-mail's own wording (greeting, button, footer, subject suffix) in the provider's language. The notification's title / message are shown as authored. */
export const notificationMailCopy = (lang: 'ar' | 'en') => lang === 'en'
	? { dir: 'ltr', greeting: (n: string) => `Hello ${n}`.trim(), open: 'Open', footer: 'You are receiving this because you chose e-mail as a notification channel in your settings.', subjectSuffix: 'Waseet AI' }
	: { dir: 'rtl', greeting: (n: string) => `أهلاً ${n}`.trim(), open: 'فتح', footer: 'وصلتك هذه الرسالة لأنك اخترت البريد كقناة إشعارات في إعداداتك.', subjectSuffix: 'Waseet AI' };

export const resolveNotificationChannels = (preferences: unknown): { push: boolean; email: boolean } => {
	const channels = preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? (preferences as Record<string, unknown>).notifChannels : undefined;
	if (!Array.isArray(channels)) return { push: true, email: false };
	return { push: channels.includes('push'), email: channels.includes('email') };
};

/**
 * A CLIENT's saved channels live in notification_preferences.settings (the client "إعدادات الإشعارات" page): inApp = the real-time push in the app,
 * email = an e-mail copy. The per-type toggles (newOffer, requestStatus, newMessage, walletActivity) are NOT applied: the settings page shows them as not controllable yet,
 * so an old saved `false` there must not silently silence anything.
 * Only what the client really saved is honoured: nothing saved keeps today's behaviour (real-time push on, no e-mail). The notification is ALWAYS stored.
 * (The page's sms / mobile-push toggles have no sender yet, so they change nothing here.)
 */
export const resolveClientNotificationChannels = (settings: unknown, _type?: string): { push: boolean; email: boolean } => {
	const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
	// two key families exist for the same two switches: the settings page's (inApp / email) and the profile page's (channel_in_app / channel_email); either one counts
	const inApp = s.inApp ?? s.channel_in_app;
	const email = s.email ?? s.channel_email;
	return { push: inApp !== false, email: email === true };
};

/** The client's own language setting is the profile's "لغة الواجهة" (العربية / English); nothing saved is Arabic. */
export const resolveClientLanguage = (interfaceLanguage: unknown): 'ar' | 'en' => (interfaceLanguage === 'English' ? 'en' : 'ar');

/**
 * A marketer's own per-event switches (settings page "تنبيهات"): an event whose switch the marketer turned off is still STORED in the inbox, but neither pushed nor e-mailed.
 * Only events that have a real sender are listed; a missing / true value keeps the event on.
 */
export const MARKETER_TYPE_TOGGLES: Record<string, string> = {
	REFERRAL_JOINED: 'marketer_new_referral',
	COMMISSION_APPROVED: 'marketer_new_commission'
};

/** The marketer's communication language (settings key written by the marketer settings page); nothing saved is Arabic. */
export const resolveMarketerLanguage = (settings: unknown): 'ar' | 'en' => {
	const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
	return s.marketer_communication_language === 'en' ? 'en' : 'ar';
};

/** Channels of a notification that points into /marketer-overview: the shared in-app / e-mail switches, then the per-event switch (off = stored only). */
export const resolveMarketerNotificationChannels = (settings: unknown, type?: string): { push: boolean; email: boolean } => {
	const channels = resolveClientNotificationChannels(settings);
	const key = type ? MARKETER_TYPE_TOGGLES[type] : undefined;
	const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
	if (key && s[key] === false) return { push: false, email: false };
	return channels;
};

const escapeMailHtml =(v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class NotificationService {
	private emitDto(dto: NotificationDto, event: 'new_notification' | 'notification_updated' = 'new_notification'): void {
		const io = getIO();
		if (!io) return;
		io.to(`user_${dto.userId}`).to(`project_owner_${dto.userId}`).emit(event, dto);
	}

	/**
	 * The channels, e-mail address and language a notification is delivered through. The channel family follows the actionUrl prefix (client / marketer / else provider);
	 * a lookup failure falls back to the default: real-time push only. Shared by deliver() and the chat digest so both read the exact same switches.
	 */
	public async resolveDelivery(userId: string, actionUrl: string | null | undefined, type?: string): Promise<{ channels: { push: boolean; email: boolean }; recipient: { email: string; firstName: string | null } | null; lang: 'ar' | 'en' }> {
		let channels = { push: true, email: false };
		let recipient: { email: string; firstName: string | null } | null = null;
		let lang: 'ar' | 'en' = 'ar';
		// An account can hold both roles: a notification that points into /client-overview follows the CLIENT's settings, anything else the provider's (as before).
		const forClient = !!actionUrl && actionUrl.startsWith('/client-overview');
		// Same rule for the marketer side: a notification into /marketer-overview follows the marketer's shared switches (and communication language), never the provider profile's.
		const forMarketer = !!actionUrl && actionUrl.startsWith('/marketer-overview');
		let profileChannels: unknown = null;
		try {
			const profile = forClient || forMarketer ? null : await prisma.providerProfile.findUnique({ where: { userId }, select: { preferences: true, user: { select: { email: true, firstName: true } } } });
			profileChannels = profile?.preferences ?? null;
			if (profile) { channels = resolveNotificationChannels(profile.preferences); lang = resolveCommunicationLanguage(profile.preferences); recipient = profile.user; }
			else if (forClient) {
				const [prefs, clientProfile, user] = await Promise.all([
					prisma.notificationPreference.findUnique({ where: { userId }, select: { settings: true } }),
					prisma.clientProfile.findUnique({ where: { userId }, select: { interfaceLanguage: true } }),
					prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true } })
				]);
				channels = resolveClientNotificationChannels(prefs?.settings, type); lang = resolveClientLanguage(clientProfile?.interfaceLanguage); recipient = user;
			}
			else if (forMarketer) {
				const [prefs, user] = await Promise.all([
					prisma.notificationPreference.findUnique({ where: { userId }, select: { settings: true } }),
					prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true } })
				]);
				channels = resolveMarketerNotificationChannels(prefs?.settings, type); lang = resolveMarketerLanguage(prefs?.settings); recipient = user;
			}
		} catch { /* default channels */ }
		// No channels chosen on a provider profile: the account's shared preferences apply (Settings / profile page: channel_in_app, channel_email). Unsaved = push on, e-mail off.
		const providerChose = Array.isArray((profileChannels as Record<string, unknown> | null)?.notifChannels);
		if (!providerChose && !forClient && !forMarketer) {
			try {
				const row = await prisma.notificationPreference.findUnique({ where: { userId }, select: { settings: true } });
				channels = resolveClientNotificationChannels(row?.settings);
				if (channels.email && !recipient) recipient = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true } });
			} catch { /* default channels */ }
		}
		return { channels, recipient, lang };
	}

	/** Delivers a stored notification through the recipient's chosen channels (a lookup failure falls back to the default: real-time push only). */
	private async deliver(dto: NotificationDto, event: 'new_notification' | 'notification_updated' = 'new_notification'): Promise<void> {
		const { channels, recipient, lang } = await this.resolveDelivery(dto.userId, dto.actionUrl, dto.type);
		if (channels.push) this.emitDto(dto, event);
		// A chat message is never mailed one by one (a negotiation would flood the inbox): unread chat messages reach the e-mail channel only as the throttled digest (chat-digest.service).
		if (channels.email && recipient?.email && dto.type !== 'CHAT') void this.sendNotificationMail(recipient.email, recipient.firstName, dto, lang);
	}

	private async sendNotificationMail(email: string, firstName: string | null, dto: NotificationDto, lang: 'ar' | 'en' = 'ar'): Promise<void> {
		const copy = notificationMailCopy(lang);
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';
		const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
		const link = dto.actionUrl ? `${base}${dto.actionUrl.startsWith('/') ? '' : '/'}${dto.actionUrl}` : '';
		try {
			await mailTransporter.sendMail({
				from: `"${senderName}" <${from}>`,
				to: email,
				subject: `${dto.title} - ${copy.subjectSuffix}`,
				html: `<div dir="${copy.dir}" style="font-family:Tahoma,Arial,sans-serif"><p>${escapeMailHtml(copy.greeting(firstName || ''))}</p><h3>${escapeMailHtml(dto.title)}</h3><p>${escapeMailHtml(dto.message)}</p>${link ? `<p><a href="${escapeMailHtml(link)}">${escapeMailHtml(dto.actionText || copy.open)}</a></p>` : ''}<p style="color:#6b7699;font-size:12px">${escapeMailHtml(copy.footer)}</p></div>`,
				text: `${dto.title}\n${dto.message}${link ? `\n${link}` : ''}`,
				headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
			});
		} catch (error) {
			logEmailFailure('notification', email, error);
		}
	}

	/** Broadcast a notification persisted as part of another database transaction. */
	public async emitStored(notificationId: string): Promise<NotificationDto> {
		const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
		if (!notification) throw new Error('Notification not found');
		const dto = toDto(notification);
		await this.deliver(dto);
		return dto;
	}

	/**
	 * The ONE place every OTP e-mail (activation, login, phone change, PayPal email) is built and sent: the same from address, sender name, HTML template, plain-text
	 * alternative and headers, so a code that arrives for one purpose is no different, for the mail provider, from a code for another. Only the subject differs.
	 * Throws on an SMTP error or a rejected recipient; logs the server's answer (message id, accepted, rejected, response) and never the code.
	 */
	private async sendOtpMail(kind: string, email: string, code: string, subject: string, validityMinutes: number = 10): Promise<EmailDeliveryResult> {
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const senderName = process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';
		const startedAt = Date.now();
		try {
			const info = await mailTransporter.sendMail({
				from: `"${senderName}" <${from}>`,
				to: email,
				subject,
				html: getOtpEmailTemplate(code, validityMinutes),
				// An HTML-only message is a spam signal: every OTP mail also carries a plain-text part.
				text: `رمز التحقق الخاص بك في وسيط AI هو: ${code}\nالرمز صالح لمدة ${otpValidityText(validityMinutes)}. لا تشاركه مع أي أحد. إذا لم تطلبه فتجاهل هذه الرسالة.`,
				headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
			});
			return logEmailDelivery(kind, email, info, Date.now() - startedAt);
		} catch (error) {
			logEmailFailure(kind, email, error, Date.now() - startedAt);
			throw error;
		}
	}

	/**
	 * Send an OTP verification code via email.
	 */
	public async sendEmailOtp(email: string, code: string): Promise<EmailDeliveryResult> {
		return this.sendOtpMail('otp', email, code, process.env.OTP_EMAIL_SUBJECT ?? 'رمز التحقق لتفعيل حسابك - Waseet AI');
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
		return this.sendOtpMail('phone-change', email, code, process.env.PHONE_CHANGE_EMAIL_SUBJECT ?? 'رمز تأكيد تغيير رقم الجوال - Waseet AI');
	}

	/** Code that completes a password login, sent to the ACCOUNT EMAIL (purpose LOGIN_EMAIL; SMS is never used for login). */
	public async sendLoginOtpEmail(email: string, code: string): Promise<EmailDeliveryResult> {
		return this.sendOtpMail('login', email, code, process.env.LOGIN_EMAIL_SUBJECT ?? 'رمز تسجيل الدخول - Waseet AI');
	}

	/** Code that confirms a change of the PayPal payout email, sent to the ACCOUNT EMAIL (never to the new, unverified address). */
	public async sendPaypalEmailChangeOtpEmail(email: string, code: string): Promise<EmailDeliveryResult> {
		return this.sendOtpMail('paypal-email-change', email, code, process.env.PAYPAL_CHANGE_EMAIL_SUBJECT || PAYPAL_OTP_DEFAULT_SUBJECT);
	}

	/** Code that confirms a payment (marketplace checkout): its own subject, never the account-activation one. */
	public async sendPaymentOtpEmail(email: string, code: string): Promise<EmailDeliveryResult> {
		// Payment codes (marketplace checkout, budget-increase authorization) are valid for 2 minutes: the mail says so.
		return this.sendOtpMail('payment', email, code, process.env.PAYMENT_OTP_EMAIL_SUBJECT || PAYMENT_OTP_DEFAULT_SUBJECT, PAYMENT_OTP_VALIDITY_MINUTES);
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
		options: { unreadOnly?: boolean; type?: string; since?: Date | null } = {},
	): Promise<NotificationDto[]> {
		const category = parseCategoryFilter(categoryFilter);

		const notifications = await prisma.notification.findMany({
			where: {
				userId,
				...(category ? { category } : {}),
				...(options.unreadOnly ? { isRead: false } : {}),
				...(options.type ? { type: options.type } : {}),
				// recovery after a socket reconnection: what was stored at or after the newest notification the client already holds (the client de-duplicates by id, so a same-millisecond tie is never lost)
				...(options.since ? { createdAt: { gte: options.since } } : {}),
			},
			orderBy: { createdAt: 'desc' },
		});

		return notifications.map(toDto);
	}

	/** The real number of unread notifications of one user (what the bell shows); never derived from a page of the list. */
	public async countUnread(userId: string): Promise<number> {
		return prisma.notification.count({ where: { userId, isRead: false } });
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

		await this.deliver(dto);

		return dto;
	}

	/**
	 * A chat message's notification. At most ONE unread CHAT notification exists per (recipient, conversation): while the recipient has not read it, the next messages of the
	 * same conversation update that row (latest text, running count in metadata.unreadCount, createdAt bumped so it sorts first, same link) and push it as `notification_updated`
	 * (same id: the client replaces the row and its bell counter does not move). Once the row is read, the next message creates a fresh row. The messages themselves are never touched.
	 * Race-safe: a transaction-scoped advisory lock per (recipient, conversation) serialises concurrent messages, and the update is conditional on the row still being unread
	 * (a read that wins the race simply makes the next message a new row). Returns the stored row and whether it was coalesced.
	 */
	public async createOrCoalesceChat(input: CreateNotificationInput & { conversationId: string }): Promise<{ dto: NotificationDto; coalesced: boolean }> {
		const context = (input.metadata as Record<string, unknown> | undefined)?.context ?? null;
		const lockKey = `chat-notif:${input.userId}:${input.conversationId}`;
		const out = await prisma.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
			const candidates = await tx.notification.findMany({
				where: { userId: input.userId, type: 'CHAT', isRead: false, metadata: { path: ['conversationId'], equals: input.conversationId } },
				orderBy: { createdAt: 'desc' },
			});
			const existing = candidates.find(n => ((n.metadata as Record<string, unknown> | null)?.context ?? null) === context);
			if (existing) {
				const prev = (existing.metadata as Record<string, unknown> | null) ?? {};
				const unreadCount = (Number(prev.unreadCount) > 0 ? Number(prev.unreadCount) : 1) + 1;
				const claimed = await tx.notification.updateMany({
					where: { id: existing.id, isRead: false },
					data: {
						message: input.message,
						title: unreadCount > 1 ? `${input.title} (${unreadCount})` : input.title,
						createdAt: new Date(),
						actionUrl: input.actionUrl ?? existing.actionUrl,
						actionText: input.actionText ?? existing.actionText,
						metadata: JSON.parse(JSON.stringify({ ...prev, ...(input.metadata ?? {}), unreadCount })),
					},
				});
				if (claimed.count === 1) return { row: await tx.notification.findUniqueOrThrow({ where: { id: existing.id } }), coalesced: true };
			}
			const row = await tx.notification.create({
				data: {
					userId: input.userId,
					title: input.title,
					message: input.message,
					category: input.category ?? NotificationCategory.ALL,
					type: 'CHAT',
					actionUrl: input.actionUrl ?? null,
					actionText: input.actionText ?? null,
					metadata: JSON.parse(JSON.stringify({ ...(input.metadata ?? {}), unreadCount: 1 })),
					isRead: false,
				},
			});
			return { row, coalesced: false };
		});
		const dto = toDto(out.row);
		await this.deliver(dto, out.coalesced ? 'notification_updated' : 'new_notification');
		return { dto, coalesced: out.coalesced };
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
	async getPreferences(userId: string): Promise<Record<string, boolean | string>> {
		const row = await prisma.notificationPreference.findUnique({ where: { userId } });
		return (row?.settings as Record<string, boolean | string>) || {};
	},

	async updatePreferences(userId: string, patch: Record<string, boolean | string>): Promise<Record<string, boolean | string>> {
		const existing = await prisma.notificationPreference.findUnique({ where: { userId } });
		const merged = { ...(existing?.settings as Record<string, boolean | string> | undefined), ...patch };
		const row = await prisma.notificationPreference.upsert({
			where: { userId },
			create: { userId, settings: merged },
			update: { settings: merged },
		});
		return row.settings as Record<string, boolean | string>;
	},
};
