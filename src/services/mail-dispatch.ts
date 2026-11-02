import type { SendMailOptions } from 'nodemailer';
import { mailTransporter } from '../utils/mail.transporter';
import { transactionalFrom, AUTO_MAIL_HEADERS } from '../utils/email-sender-name';
import { optionalEmailEnabled } from './optional-email-gate';
import { prisma } from '../config/db';
import { logger } from '../config/logger';

/**
 * THE central policy and sender of the mails that belong to a BUSINESS EVENT (EMAIL-AUDIT-2026-10-26.md, Round 2).
 *
 * Three classes (owner decision 3):
 *  - AUTH           login / activation / password-reset / payment / signature / phone / PayPal / invitation codes. Independent channel: never gated by the platform
 *                   switch nor by a preference. (Built and sent by notification.service sendOtpMail & friends; listed here so the matrix is ONE table.)
 *  - TRANSACTIONAL  mail REQUIRED to complete an operation (escrow deposit receipt, provider contract-signature invitation). Never gated by the optional switch
 *                   nor by a preference.
 *  - OPTIONAL       everything the user may opt in / out of (notification copies, unread-chat digest, project completion reward, model audit result). Sent only when
 *                   the platform switch `channelEmail` is ON AND the user chose e-mail; the platform switch always wins; evaluated at SEND time.
 *  - SYSTEM         the institutional admin mailbox: its own setting, no user data (not a user preference mail).
 *
 * ONE MAIL PER EVENT / PURPOSE / RECIPIENT:
 *  1. COVERED_NOTIFICATIONS: an in-app notification whose event already has a dedicated mail is stored and pushed but never mailed a second time. The dedicated mail
 *     carries the whole content (amounts, references, links); the table is static, so it holds across retries, restarts and duplicate callbacks by construction.
 *  2. The idempotency ledger below: a mail keyed by (purpose, recipient, event) is sent at most once. It is claimed before the send and released when the send fails
 *     (so a retry can still deliver). Durable when the event has a notification row (the claim is an atomic conditional write into that row's metadata, no schema
 *     change); otherwise per process with a bounded memory (those operations are additionally guarded by their own state transition, e.g. a contract that already
 *     moved on answers 409 to a repeated deposit).
 */
export type MailClass = 'AUTH' | 'TRANSACTIONAL' | 'OPTIONAL' | 'SYSTEM';

export const MAIL_PURPOSES = {
	'login-code': { klass: 'AUTH' },
	'activation-code': { klass: 'AUTH' },
	'password-reset-code': { klass: 'AUTH' },
	'payment-code': { klass: 'AUTH' },
	'contract-signature-code': { klass: 'AUTH' },
	'phone-change-code': { klass: 'AUTH' },
	'paypal-change-code': { klass: 'AUTH' },
	'admin-invite-code': { klass: 'AUTH' },
	'escrow-deposit-receipt': { klass: 'TRANSACTIONAL' },
	'provider-contract-invitation': { klass: 'TRANSACTIONAL' },
	'notification-copy': { klass: 'OPTIONAL' },
	'chat-digest': { klass: 'OPTIONAL' },
	'project-completion-reward': { klass: 'OPTIONAL' },
	'model-audit-result': { klass: 'OPTIONAL' },
	'admin-mailbox-alert': { klass: 'SYSTEM' },
} as const satisfies Record<string, { klass: MailClass }>;
export type MailPurpose = keyof typeof MAIL_PURPOSES;
export const mailClassOf = (purpose: MailPurpose): MailClass => MAIL_PURPOSES[purpose].klass;

/**
 * Notification type -> the dedicated mail that already carries that event for the same recipient. The notification itself stays (inbox + push); only its e-mail COPY is dropped.
 *  ESCROW_FUNDED (client)               -> the escrow deposit receipt (amount, project, next step, link to the client's projects)
 *  OFFER_ACCEPTED (provider)            -> the contract-signature invitation (client, amount, project, sign link)
 *  PROJECT_COMPLETION_REWARD (provider) -> the project completion reward mail (project, +points, link)
 * Each of these types has exactly one producer, which also sends the dedicated mail (client-requests depositEscrow / project-progress review).
 */
export const COVERED_NOTIFICATIONS: Readonly<Record<string, MailPurpose>> = {
	ESCROW_FUNDED: 'escrow-deposit-receipt',
	OFFER_ACCEPTED: 'provider-contract-invitation',
	PROJECT_COMPLETION_REWARD: 'project-completion-reward',
};
export const coveringMailOf = (notificationType: string | null | undefined): MailPurpose | null => (notificationType ? COVERED_NOTIFICATIONS[notificationType] ?? null : null);

// ───────────── idempotency ledger ─────────────
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const LEDGER_MAX = 5000;
const memory = new Map<string, number>();
export const resetMailLedger = () => memory.clear();
const ledgerKey = (purpose: string, recipient: string, event: string) => `${purpose}|${recipient.toLowerCase()}|${event}`;
const claimMetaKey = (purpose: string) => `mailClaim:${purpose}`;

function claimInMemory(key: string, now = Date.now()): boolean {
	const at = memory.get(key);
	if (at !== undefined && now - at < LEDGER_TTL_MS) return false;
	if (memory.size >= LEDGER_MAX) for (const [k, t] of memory) { if (now - t >= LEDGER_TTL_MS || memory.size >= LEDGER_MAX) memory.delete(k); if (memory.size < LEDGER_MAX * 0.9) break; }
	memory.set(key, now);
	return true;
}

/** Durable claim in the notification's own metadata: ONE atomic conditional UPDATE. 'claimed' | 'taken' | 'no-row' (the row does not exist: memory alone decides). Throws on a store failure. */
async function claimOnNotification(notificationId: string, purpose: string): Promise<'claimed' | 'taken' | 'no-row'> {
	const key = claimMetaKey(purpose);
	const updated = await prisma.$executeRaw`UPDATE notifications SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(${key}::text, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) WHERE id = ${notificationId} AND NOT (COALESCE(metadata, '{}'::jsonb) ? ${key}::text)`;
	if (updated > 0) return 'claimed';
	const exists = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM notifications WHERE id = ${notificationId}`;
	return exists.length ? 'taken' : 'no-row';
}
async function releaseOnNotification(notificationId: string, purpose: string): Promise<void> {
	const key = claimMetaKey(purpose);
	await prisma.$executeRaw`UPDATE notifications SET metadata = metadata - ${key}::text WHERE id = ${notificationId} AND metadata ? ${key}::text`;
}

export interface DispatchInput {
	purpose: MailPurpose;
	to: string;
	/** stable id of the recipient (user id, else the address): part of the ledger key */
	recipientKey: string;
	/** the business event (contract id, notification id, project id ...). Omitted = no ledger (the caller has its own guard). */
	eventKey?: string;
	/** when the event has a notification row, the ledger claim is stored durably in it */
	anchorNotificationId?: string;
	subject: string;
	html: string;
	/** REQUIRED: an HTML-only message is a spam signal */
	text: string;
	from?: string;
	/** the caller's own transporter binding (defaults to the shared one) */
	transport?: { sendMail: (m: SendMailOptions) => Promise<unknown> };
}
export type DispatchResult =
	| { status: 'sent'; info: unknown }
	| { status: 'suppressed'; reason: 'platform-off' | 'duplicate' }
	| { status: 'failed'; error: unknown };

/**
 * The one send for event mails. Applies the class rule (OPTIONAL = the platform switch, checked now), the one-mail-per-event ledger, the shared From, the plain-text part and the
 * auto-submitted headers. Never throws: the business action must not fail because of a mail.
 */
export async function dispatchMail(input: DispatchInput): Promise<DispatchResult> {
	const klass = mailClassOf(input.purpose);
	if (!input.text || !input.text.trim()) { logger.error(`[Mail:${input.purpose}] refused: no plain-text part`); return { status: 'failed', error: new Error('missing plain-text part') }; }
	if (klass === 'OPTIONAL' && !(await optionalEmailEnabled())) return { status: 'suppressed', reason: 'platform-off' };
	const key = input.eventKey ? ledgerKey(input.purpose, input.recipientKey, input.eventKey) : null;
	let durable = false;
	let memoryClaimed = false;
	if (key) {
		if (input.anchorNotificationId) {
			// the event has a notification row: the claim lives in it (atomic, shared by every instance and surviving a restart)
			try {
				const outcome = await claimOnNotification(input.anchorNotificationId, input.purpose);
				if (outcome === 'taken') return { status: 'suppressed', reason: 'duplicate' };
				durable = outcome === 'claimed';
				if (outcome === 'no-row') { if (!claimInMemory(key)) return { status: 'suppressed', reason: 'duplicate' }; memoryClaimed = true; }
			} catch { /* the durable store is unreadable: fail OPEN (at-least-once beats losing the mail) */ }
		} else {
			if (!claimInMemory(key)) return { status: 'suppressed', reason: 'duplicate' };
			memoryClaimed = true;
		}
	}
	try {
		const message: SendMailOptions = { from: input.from ?? await transactionalFrom(), to: input.to, subject: input.subject, html: input.html, text: input.text, headers: { ...AUTO_MAIL_HEADERS } };
		const info = await (input.transport ?? mailTransporter).sendMail(message);
		return { status: 'sent', info };
	} catch (error) {
		// a failed send must stay retryable
		if (key) { if (memoryClaimed) memory.delete(key); if (durable && input.anchorNotificationId) await releaseOnNotification(input.anchorNotificationId, input.purpose).catch(() => undefined); }
		logger.error(`[Mail:${input.purpose}] send failed: ${(error as Error)?.message ?? error}`);
		return { status: 'failed', error };
	}
}
