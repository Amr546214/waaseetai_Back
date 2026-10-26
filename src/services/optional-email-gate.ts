import { systemSettingsService } from './system-settings.service';
import { AppError } from '../utils/app-error';

/**
 * THE gate of OPTIONAL e-mail (platform setting `channelEmail`). Optional = mail the user can opt in / out of in their notification preferences
 * (notification copies, the unread-chat digest, project completion reward, model audit result). It is checked at EXECUTION time (right before a send, in the
 * digest scheduler, in every retry) and never at enqueue time only, so a mail prepared while the channel was ON is not sent once it is OFF.
 *
 * NOT gated here (independent channel, always sent): login codes, activation / verification codes, password-reset mail (see EMAIL-AUDIT-2026-10-26.md).
 * The user's stored choice is never read or written by this gate: ON again = the earlier choices apply again.
 */
export const EMAIL_CHANNEL_DISABLED_CODE = 'EMAIL_CHANNEL_DISABLED_BY_PLATFORM';
export const EMAIL_CHANNEL_DISABLED_MESSAGE = 'معطّل بواسطة إدارة المنصة';

/** true = optional mail may be sent (default ON = today's behaviour; an unreadable store keeps the last known value). Never throws. */
export async function optionalEmailEnabled(): Promise<boolean> {
	try { return (await systemSettingsService.get<boolean>('channelEmail')) !== false; } catch { return true; }
}

export const emailChannelDisabledError = () => new AppError(EMAIL_CHANNEL_DISABLED_MESSAGE, 409, [{ code: EMAIL_CHANNEL_DISABLED_CODE, message: EMAIL_CHANNEL_DISABLED_MESSAGE }], EMAIL_CHANNEL_DISABLED_CODE);

/**
 * Throws 409 EMAIL_CHANNEL_DISABLED_BY_PLATFORM when `wantsOn` would switch the user's e-mail option ON (from not-on) while the platform has the channel OFF.
 * A request that merely repeats the stored value, or switches the option OFF (withdrawing consent is never blocked), passes. Nothing is written here.
 */
export async function assertEmailOptionMayChange(wantsOn: boolean, wasOn: boolean): Promise<void> {
	if (!wantsOn || wasOn) return;
	if (!(await optionalEmailEnabled())) throw emailChannelDisabledError();
}
