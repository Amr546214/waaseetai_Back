import jwt from 'jsonwebtoken';
import { systemSettingsService } from '../services/system-settings.service';

/**
 * The one place that issues a sign-in token. Its lifetime is the setting `sessionMaxHours` (the ABSOLUTE maximum age of a session, independent of idleness), read when the token is issued:
 * a change reaches NEW sessions; a session that already exists keeps the expiry it was issued with (nobody is signed out by editing this setting).
 */
export async function issueAccessToken(payload: Record<string, unknown>, jwtSecret: string): Promise<{ token: string; expiresAt: Date; hours: number }> {
	const hours = await systemSettingsService.get<number>('sessionMaxHours');
	const token = jwt.sign(payload, jwtSecret, { expiresIn: `${hours}h` });
	return { token, expiresAt: new Date(Date.now() + hours * 3_600_000), hours };
}
