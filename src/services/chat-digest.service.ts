import { buildNotificationEmailHtml } from '../utils/notification-email-template';
import { siteUrl } from '../utils/site-url';
import { brandSubject } from '../utils/brand';
import { emailSenderName } from '../utils/email-sender-name';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { mailTransporter } from '../utils/mail.transporter';
import { optionalEmailEnabled } from './optional-email-gate';
import { notificationService, notificationMailCopy, maskEmail } from './notification.service';

/**
 * Chat e-mail DIGEST. Never one mail per message: for a recipient who switched the e-mail channel on, ONE summary mail per conversation, at most every 15 minutes, and only
 * while unread messages from the other party remain. Off unless CHAT_DIGEST_EMAIL_ENABLED=true (see startChatDigestScheduler).
 *
 *  - Nothing historical: only messages created AFTER the activation time (the stored first-run time, or CHAT_DIGEST_EMAIL_ENABLED_FROM when later) are ever counted or mailed.
 *  - Only unread: the chat `messages` table is the source of truth (status != READ); a notification row that is still unread but whose messages were read in the chat is skipped.
 *  - A digest is sent only for messages newer than the previous digest of that conversation (the same unread backlog is not mailed twice), and only once the oldest such message
 *    is at least CHAT_DIGEST_MIN_AGE_MIN old (default 5): somebody who is online and answers promptly never gets a mail.
 *  - Channels: the exact resolver of the notification's link family (client / marketer / provider), via NotificationService.resolveDelivery.
 *  - Idempotent: the (user, conversation) last-digest time is CLAIMED with a conditional upsert BEFORE sending, so two instances or a restart cannot send the same digest twice;
 *    a failed send restores the previous value (so the next tick may retry) and never throws.
 *  - Anti-flood: at most CHAT_DIGEST_MAX_PER_USER_HOUR digests per user per hour (default 4), counted from the claim table (one slot per conversation).
 */
export const CHAT_DIGEST_MIN_INTERVAL_MIN = 15;

const num = (v: string | undefined, d: number, min: number) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };

export interface ChatDigestConfig { intervalMs: number; minAgeMs: number; maxPerUserHour: number; batch: number }
export const chatDigestConfig = (): ChatDigestConfig => ({
	// never below 15 minutes, whatever the env says
	intervalMs: num(process.env.CHAT_DIGEST_INTERVAL_MIN, CHAT_DIGEST_MIN_INTERVAL_MIN, CHAT_DIGEST_MIN_INTERVAL_MIN) * 60_000,
	minAgeMs: num(process.env.CHAT_DIGEST_MIN_AGE_MIN, 5, 0) * 60_000,
	maxPerUserHour: num(process.env.CHAT_DIGEST_MAX_PER_USER_HOUR, 4, 1),
	batch: num(process.env.CHAT_DIGEST_BATCH, 200, 1),
});

/** The activation time: stored once on the first run (never moves earlier), pushed later by CHAT_DIGEST_EMAIL_ENABLED_FROM when that is a later valid date. */
export async function resolveChatDigestActivation(now: Date = new Date()): Promise<Date> {
	await prisma.$executeRaw`INSERT INTO chat_digest_activation (id, enabled_at) VALUES ('default', ${now}) ON CONFLICT (id) DO NOTHING`;
	const row = await prisma.chatDigestActivation.findUniqueOrThrow({ where: { id: 'default' } });
	const fromEnv = process.env.CHAT_DIGEST_EMAIL_ENABLED_FROM ? new Date(process.env.CHAT_DIGEST_EMAIL_ENABLED_FROM) : null;
	return fromEnv && !Number.isNaN(fromEnv.getTime()) && fromEnv > row.enabledAt ? fromEnv : row.enabledAt;
}

export const chatDigestMailCopy = (lang: 'ar' | 'en', count: number) => lang === 'en'
	? { subject: 'Unread messages - Waseet AI', headline: count === 1 ? 'You have 1 unread message' : `You have ${count} unread messages`, latest: 'Latest message' }
	: { subject: 'رسائل غير مقروءة - Waseet AI', headline: count === 1 ? 'لديك رسالة غير مقروءة' : `لديك ${count} رسائل غير مقروءة`, latest: 'آخر رسالة' };

class DigestSuppressed extends Error { constructor() { super('optional e-mail is switched off by the platform'); } }

async function sendDigestMail(email: string, firstName: string | null, lang: 'ar' | 'en', count: number, title: string, preview: string, actionUrl: string | null, actionText: string | null): Promise<void> {
	// execution-time gate: the claim above was made while the channel looked ON; a switch-off in between sends nothing
	if (!(await optionalEmailEnabled())) throw new DigestSuppressed();
	const copy = notificationMailCopy(lang);
	const d = chatDigestMailCopy(lang, count);
	const from = process.env.SMTP_FROM ?? 'no-reply@waseetai.com';
	const senderName = await emailSenderName();
	const link = actionUrl ? siteUrl(actionUrl) ?? '' : '';
	const short = preview.length > 140 ? `${preview.slice(0, 140)}...` : preview;
	await mailTransporter.sendMail({
		from: `"${senderName}" <${from}>`,
		to: email,
		subject: brandSubject(d.subject),
		html: buildNotificationEmailHtml({ lang, greeting: copy.greeting(firstName || ''), title: d.headline, message: `${title.replace(/\s*\(\d+\)$/, '')}\n${d.latest}: ${short}`, linkUrl: link || null, ctaLabel: actionText || copy.open, footerNote: copy.footer }),
		text: `${d.headline}\n${d.latest}: ${short}${link ? `\n${link}` : ''}`,
		headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
	});
}

export interface ChatDigestRunResult { considered: number; sent: number; skipped: Record<string, number> }

/** One pass. `now` is injectable for tests. Never throws. */
export async function runChatDigestOnce(opts: { now?: Date } = {}): Promise<ChatDigestRunResult> {
	const now = opts.now ?? new Date();
	const result: ChatDigestRunResult = { considered: 0, sent: 0, skipped: {} };
	const skip = (why: string) => { result.skipped[why] = (result.skipped[why] ?? 0) + 1; };
	try {
		const cfg = chatDigestConfig();
		// platform switch OFF: the whole pass is a no-op (nothing claimed, nothing sent, nothing consumed); the unread backlog is still there when the channel is ON again
		if (!(await optionalEmailEnabled())) { skip('platform-email-off'); return result; }
		const enabledAt = await resolveChatDigestActivation(now);
		const rows = await prisma.notification.findMany({ where: { type: 'CHAT', isRead: false, createdAt: { gt: enabledAt } }, orderBy: { createdAt: 'asc' }, take: cfg.batch });
		for (const n of rows) {
			result.considered++;
			try {
				const conversationId = (n.metadata as Record<string, unknown> | null)?.conversationId;
				if (typeof conversationId !== 'string') { skip('no-conversation'); continue; }
				const state = await prisma.chatDigestState.findUnique({ where: { userId_conversationId: { userId: n.userId, conversationId } } });
				const last = state?.lastDigestAt ?? null;
				if (last && now.getTime() - last.getTime() < cfg.intervalMs) { skip('window'); continue; }
				const unreadWhere = { conversationId, senderId: { not: n.userId }, status: { not: 'READ' as const } };
				const pendingAfter = last && last > enabledAt ? last : enabledAt;
				const pending = await prisma.message.aggregate({ where: { ...unreadWhere, createdAt: { gt: pendingAfter } }, _count: { _all: true }, _min: { createdAt: true } });
				if (!pending._count._all) { skip('nothing-new-unread'); continue; }
				if (now.getTime() - (pending._min.createdAt as Date).getTime() < cfg.minAgeMs) { skip('too-fresh'); continue; }
				const total = await prisma.message.count({ where: { ...unreadWhere, createdAt: { gt: enabledAt } } });
				const { channels, recipient, lang } = await notificationService.resolveDelivery(n.userId, n.actionUrl, 'CHAT');
				if (!channels.email || !recipient?.email) { skip('email-off'); continue; }
				const hourly = await prisma.chatDigestState.count({ where: { userId: n.userId, lastDigestAt: { gt: new Date(now.getTime() - 3_600_000) } } });
				if (hourly >= cfg.maxPerUserHour) { skip('hourly-cap'); continue; }
				// CLAIM first (conditional): a second instance / a restart gets 0 rows and sends nothing.
				const windowStart = new Date(now.getTime() - cfg.intervalMs);
				const claimed = await prisma.$executeRaw`INSERT INTO chat_digest_state (user_id, conversation_id, last_digest_at) VALUES (${n.userId}, ${conversationId}, ${now})
					ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_digest_at = EXCLUDED.last_digest_at WHERE chat_digest_state.last_digest_at <= ${windowStart}`;
				if (claimed !== 1) { skip('claimed-elsewhere'); continue; }
				try {
					await sendDigestMail(recipient.email, recipient.firstName, lang, total, n.title, n.message, n.actionUrl, n.actionText);
					result.sent++;
				} catch (e) {
					if (e instanceof DigestSuppressed) { /* give the slot back below, count it as skipped */ }
					else logger.error(`[ChatDigest] send failed to=${maskEmail(recipient.email)}: ${(e as Error)?.message ?? e}`);
					// give the slot back so the next pass may retry
					if (last) await prisma.$executeRaw`UPDATE chat_digest_state SET last_digest_at = ${last} WHERE user_id = ${n.userId} AND conversation_id = ${conversationId} AND last_digest_at = ${now}`;
					else await prisma.$executeRaw`DELETE FROM chat_digest_state WHERE user_id = ${n.userId} AND conversation_id = ${conversationId} AND last_digest_at = ${now}`;
					skip(e instanceof DigestSuppressed ? 'email-off' : 'send-failed');
				}
			} catch (e) {
				logger.error(`[ChatDigest] row failed: ${(e as Error)?.message ?? e}`);
				skip('error');
			}
		}
	} catch (e) {
		logger.error(`[ChatDigest] pass failed: ${(e as Error)?.message ?? e}`);
		skip('pass-error');
	}
	return result;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the in-process scheduler when CHAT_DIGEST_EMAIL_ENABLED=true (default OFF). Safe with several instances (claims) and a no-op when called twice. */
export function startChatDigestScheduler(): boolean {
	if (process.env.CHAT_DIGEST_EMAIL_ENABLED !== 'true' || timer) return false;
	const tick = num(process.env.CHAT_DIGEST_TICK_MS, 60_000, 1_000);
	let running = false;
	timer = setInterval(() => { if (running) return; running = true; void runChatDigestOnce().finally(() => { running = false; }); }, tick);
	timer.unref();
	logger.info(`[ChatDigest] scheduler started (tick ${tick}ms)`);
	return true;
}

export function stopChatDigestScheduler(): void { if (timer) { clearInterval(timer); timer = null; } }
