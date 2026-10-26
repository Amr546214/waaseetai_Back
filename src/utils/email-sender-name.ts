import { systemSettingsService } from '../services/system-settings.service';

/** Display name on outgoing e-mail: the platform name set by the SUPER_ADMIN (setting `platformName`), else the server's EMAIL_SENDER_NAME, else the built-in name. Never throws. */
export async function emailSenderName(): Promise<string> {
	try { const n = String(await systemSettingsService.get<string>('platformName')).trim(); if (n) return n; } catch { /* use the fallbacks */ }
	return process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';
}

/** The one From header of every system mail: "<platform name>" <SMTP_FROM>. Same address as the notification / OTP mails (a different From per mail type hurts SPF/DKIM alignment). */
export async function transactionalFrom(): Promise<string> {
	return `"${await emailSenderName()}" <${process.env.SMTP_FROM ?? 'no-reply@waseetai.com'}>`;
}
/** machine-generated mail: auto-responders must not answer it */
export const AUTO_MAIL_HEADERS = { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } as const;
