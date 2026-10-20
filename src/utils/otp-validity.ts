/** Plain wording of a validity in minutes (the mail must state the REAL validity of the code it carries). */
export const otpValidityText = (minutes: number): string => (minutes === 1 ? 'دقيقة واحدة' : minutes === 2 ? 'دقيقتين' : minutes >= 3 && minutes <= 10 ? `${minutes} دقائق` : `${minutes} دقيقة`);

/**
 * Whole minutes of validity left, rounded DOWN, at least 1: what a mail carrying an already-issued code may promise. A 3-second grace absorbs the few
 * milliseconds between creating a code and mailing it, so a code issued just now says 10 (not 9.99 -> 9); a re-sent one with 4:30 left says 4.
 */
export const OTP_MINUTES_GRACE_MS = 3000;
export const remainingMinutes = (expiresAt: Date, now: number = Date.now()): number => Math.max(1, Math.floor((expiresAt.getTime() - now + OTP_MINUTES_GRACE_MS) / 60000));
