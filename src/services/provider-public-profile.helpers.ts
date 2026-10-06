// Pure, DB-free helpers for GET /provider/profile/public (provider-profile.service.ts getPublicProfile).
// Everything here maps stored rows to response fields and never invents a value: a missing source is `null`.

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface PublicAssessmentAttemptRow {
  totalQuestions?: number | null;
  timeLimitMinutes?: number | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  submittedAnswers?: unknown;
  score?: number | null;
  feedbackAr?: string | null;
  strengths?: string[] | null;
  weaknesses?: string[] | null;
}

/**
 * Detail card of the latest COMPLETED assessment attempt, from the real AssessmentAttempt row only.
 * - totalQuestions / timeLimitMinutes: the stored values (null when the column is null) — never a default.
 * - timeSpentMinutes: completedAt − startedAt in whole minutes; null when the attempt has not completed.
 * - answeredCount: number of keys of `submittedAnswers`; null when the answers were never submitted.
 * - timeTakenMinutes: DEPRECATED alias kept for compatibility. It is the time LIMIT (timeLimitMinutes), not the time taken;
 *   use timeSpentMinutes. It no longer falls back to an invented 12.
 * Returns null when there is no attempt.
 */
export function buildAssessmentDetails(attempt: PublicAssessmentAttemptRow | null | undefined, specialty: { latestScore?: number | null; passedAt?: Date | string | null } = {}) {
  if (!attempt) return null;

  const started = toDate(attempt.startedAt);
  const completed = toDate(attempt.completedAt);
  const timeSpentMinutes = started && completed ? Math.max(0, Math.round((completed.getTime() - started.getTime()) / 60000)) : null;

  const answers = attempt.submittedAnswers;
  const answeredCount = answers && typeof answers === 'object' && !Array.isArray(answers) ? Object.keys(answers as Record<string, unknown>).length : null;

  return {
    totalQuestions: attempt.totalQuestions ?? null,
    timeLimitMinutes: attempt.timeLimitMinutes ?? null,
    timeSpentMinutes,
    answeredCount,
    // @deprecated — this is the time LIMIT, kept only so existing clients keep working. Use timeSpentMinutes / timeLimitMinutes.
    timeTakenMinutes: attempt.timeLimitMinutes ?? null,
    score: attempt.score || specialty.latestScore || 0,
    feedbackAr: attempt.feedbackAr || '',
    strengths: attempt.strengths || [],
    weaknesses: attempt.weaknesses || [],
    completedAt: completed ?? toDate(specialty.passedAt) ?? null,
  };
}

/** Adds `specialtyName` (Arabic name first) next to the untouched `specialtyId` of each published service. */
export function withSpecialtyName<T extends { specialty?: { nameAr?: string | null; name?: string | null } | null }>(service: T) {
  const { specialty, ...rest } = service;
  return { ...rest, specialtyName: specialty?.nameAr || specialty?.name || null };
}

/** Company-only summary of the public profile: the registered company name and the NUMBER of ACTIVE team members (no names/emails/documents). */
export function buildCompanySummary(args: { accountType?: string | null; companyName?: string | null; activeTeamMembersCount: number }) {
  if (args.accountType !== 'PROVIDER_COMPANY') return null;
  return { companyName: args.companyName || null, activeTeamMembersCount: args.activeTeamMembersCount };
}
