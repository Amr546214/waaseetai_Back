// When can a provider take the specialty test again? ONE rule for the test itself (services/ai-assessment.service.ts refuses a too-early start) and for the pages that
// tell the provider in advance ("you can retake in X hours"), so the message and the refusal can never disagree.
export const ASSESSMENT_RETAKE_COOLDOWN_HOURS = Math.max(0, Number(process.env.ASSESSMENT_RETAKE_COOLDOWN_HOURS ?? 24));
export const ASSESSMENT_MAX_ATTEMPTS_PER_30_DAYS = Math.max(1, Number(process.env.ASSESSMENT_MAX_ATTEMPTS_30D ?? 5));
export const ASSESSMENT_ATTEMPT_WINDOW_DAYS = 30;
/** Attempt statuses that count toward the limit and the cooldown (a finished attempt, not one still in progress). */
export const COUNTED_ATTEMPT_STATUS_NAMES = ['COMPLETED', 'FAILED', 'EXPIRED'] as const;

export interface AttemptTimes { completedAt?: Date | string | null; createdAt: Date | string }

/** `recent` = the counted attempts of the last 30 days, newest first. */
export function computeRetryWindow(recent: AttemptTimes[], now = Date.now()): { limitReached: boolean; retryAfterSeconds: number } {
  const limitReached = recent.length >= ASSESSMENT_MAX_ATTEMPTS_PER_30_DAYS;
  const last = recent[0];
  let retryAfterSeconds = 0;
  if (last && ASSESSMENT_RETAKE_COOLDOWN_HOURS > 0) {
    const lastAt = new Date(last.completedAt ?? last.createdAt).getTime();
    const waitMs = lastAt + ASSESSMENT_RETAKE_COOLDOWN_HOURS * 3600 * 1000 - now;
    if (waitMs > 0) retryAfterSeconds = Math.ceil(waitMs / 1000);
  }
  return { limitReached, retryAfterSeconds };
}
