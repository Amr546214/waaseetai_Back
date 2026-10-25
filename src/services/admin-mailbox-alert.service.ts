import { logger } from '../config/logger';
import { mailTransporter } from '../utils/mail.transporter';
import { buildNotificationEmailHtml } from '../utils/notification-email-template';
import { siteUrl } from '../utils/site-url';
import { brandSubject } from '../utils/brand';
import { systemSettingsService } from './system-settings.service';
import { emailSenderName } from '../utils/email-sender-name';

/**
 * The administration MAILBOX (setting `adminNotificationEmail`): ONE shared institutional address that is told, by e-mail, that something new waits in the console. It is NOT the in-app
 * recipient list (that is built from staff permissions, see admin-access.service) and is never mixed with it.
 *
 * Events: NEW_DISPUTE, NEW_TICKET, WITHDRAWAL_REQUESTED, KYC_SUBMITTED. (The two money-incident events - SUSPICIOUS_PAYMENT, PAYOUT_FAILED - are NOT mailed: owner decision pending.)
 * Content: ONLY the kind of event, the opaque item id and a link into the console. No names, e-mail addresses, amounts, titles, descriptions or file names; the details are visible only after
 * signing in to the console with the permission for that work.
 * Rate: at most ONE mail per event kind per minute (the console always lists every item). A failure is logged and never reaches the business action.
 */
const maskEmail = (email: string): string => `${String(email).split('@')[0].slice(0, 1)}***@${String(email).split('@')[1] ?? ''}`;
export const MAILBOX_EVENTS = { NEW_DISPUTE: 'نزاع جديد', NEW_TICKET: 'تذكرة دعم جديدة', WITHDRAWAL_REQUESTED: 'طلب سحب جديد', KYC_SUBMITTED: 'مستند هوية جديد' } as const;
export type MailboxEvent = keyof typeof MAILBOX_EVENTS;
export const MAILBOX_WINDOW_MS = 60_000;
const last = new Map<string, number>();
export const resetMailboxThrottle = () => last.clear();

export async function sendAdminMailboxAlert(event: string, actionUrl: string, itemId?: string): Promise<'sent' | 'skipped' | 'failed'> {
	try {
		if (!(event in MAILBOX_EVENTS)) return 'skipped';
		const to = String(await systemSettingsService.get<string>('adminNotificationEmail') || '').trim();
		if (!to) return 'skipped';
		const now = Date.now(); if (now - (last.get(event) ?? 0) < MAILBOX_WINDOW_MS) return 'skipped'; last.set(event, now);
		const label = MAILBOX_EVENTS[event as MailboxEvent]; const link = siteUrl(actionUrl);
		const message = `يوجد عنصر جديد بانتظار المراجعة${itemId ? ` (المعرّف ${String(itemId).slice(0, 36)})` : ''}. الاطلاع على التفاصيل يتطلب تسجيل الدخول إلى لوحة الإدارة بصلاحية مناسبة.`;
		const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
		const info = await mailTransporter.sendMail({
			from: `"${await emailSenderName()}" <${from}>`, to, subject: brandSubject(`تنبيه إداري: ${label} - Waseet AI`),
			html: buildNotificationEmailHtml({ lang: 'ar', greeting: '', title: label, message, linkUrl: link, ctaLabel: 'فتح في لوحة الإدارة', footerNote: 'تنبيه إلى صندوق الإدارة. لا يتضمن بيانات المستخدمين.' }),
			text: `${label}\n${message}\n${link}`, headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
		});
		if (!info?.accepted?.length) { logger.error(`[AdminMailbox] ${event}: recipient not accepted (${maskEmail(to)})`); return 'failed'; }
		return 'sent';
	} catch (e) { logger.error(`[AdminMailbox] ${event} failed: ${(e as Error)?.message ?? e}`); return 'failed'; }
}
