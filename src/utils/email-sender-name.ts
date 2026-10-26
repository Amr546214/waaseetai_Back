import { systemSettingsService } from '../services/system-settings.service';

/** Display name on outgoing e-mail: the platform name set by the SUPER_ADMIN (setting `platformName`), else the server's EMAIL_SENDER_NAME, else the built-in name. Never throws. */
export async function emailSenderName(): Promise<string> {
	try { const n = String(await systemSettingsService.get<string>('platformName')).trim(); if (n) return n; } catch { /* use the fallbacks */ }
	return process.env.EMAIL_SENDER_NAME ?? 'Waseet AI';
}
