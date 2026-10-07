import { AssessmentStatus, Prisma, SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { AppError } from '../utils/app-error';
import { evaluateAssessment, AnswerLogEntry } from '../utils/assessment-review-flags';

// AI assessments run exclusively through the external WaseetAI service:
//  - generation: POST /v1/ai/assessments/stream (socket) or /v1/ai/assessments (REST)
//  - grading:    POST /v1/ai/assessments/:attemptId/submit
// There is no direct model path, no fallback and no locally fabricated
// question, score, pass/fail or feedback. This backend keeps what it owns:
// ownership checks, rate limiting, the generation claim / twin-transport race
// protection, timing/expiry, idempotent submission and the ProviderSpecialty /
// tier effects. WaseetAI never sends an answer key, so none is stored for new
// attempts; the WaseetAI attempt id lives in the existing `analyzedAssetsSnapshot`
// JSON column. Attempts created before this integration (local answer key, no
// vendor attempt id) remain gradable by a deterministic local comparison.

export const ASSESSMENT_QUESTION_COUNT = 20;
export const ASSESSMENT_TIME_LIMIT_MINUTES = 15;
const GRADING_TIMEOUT_MS = 45_000;
// A grading claim older than this is considered abandoned (e.g. process crash)
// and may be released so the user can retry.
const STALE_GRADING_CLAIM_MS = 120_000;

export const ASSESSMENT_GENERATION_FAILED_CODE = 'ASSESSMENT_GENERATION_FAILED';
export const ASSESSMENT_GENERATION_FAILED_MESSAGE = 'تعذر توليد أسئلة التقييم عبر خدمة الذكاء الاصطناعي حالياً. يرجى المحاولة لاحقاً.';
export const ASSESSMENT_GRADING_FAILED_CODE = 'ASSESSMENT_GRADING_FAILED';
export const ASSESSMENT_GRADING_FAILED_MESSAGE = 'تعذر تصحيح التقييم عبر خدمة الذكاء الاصطناعي حالياً. لم يتم تسجيل أي نتيجة، يمكنك إعادة تسليم إجاباتك.';
export const ASSESSMENT_NOT_GRADABLE_CODE = 'ASSESSMENT_NOT_GRADABLE';

/** Question as shown to the user — never carries an answer key. */
export interface PublicAssessmentQuestion {
  id: number | string;
  textAr: string;
  options: Array<{ id: string; text: string }>;
  assessmentArea?: string;
}

/** Stored question. `correctAnswer`/`explanation` exist only on legacy
 *  (pre-WaseetAI) attempts. */
interface StoredQuestion extends PublicAssessmentQuestion {
  correctAnswer?: string;
  explanation?: string;
}

export interface GenerateAssessmentResponse {
  attemptId: string;
  questions: PublicAssessmentQuestion[];
  timeLimitMinutes: number;
  /** Relayed verbatim from WaseetAI when it reports one; never relabelled. */
  generationSource?: string;
}

export interface SubmitAssessmentResponse {
  attemptId: string;
  score: number;
  isPassed: boolean;
  status: AssessmentStatus;
  feedbackAr: string;
  strengths: string[];
  weaknesses: string[];
  completedAt: Date;
}

export const SUBMITTABLE_STATUSES: AssessmentStatus[] = [AssessmentStatus.IN_PROGRESS, AssessmentStatus.STREAMING];

export function sanitizeQuestions(questions: StoredQuestion[]): PublicAssessmentQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    textAr: q.textAr,
    options: (q.options || []).map((opt) => ({ id: opt.id, text: opt.text })),
    ...(q.assessmentArea ? { assessmentArea: q.assessmentArea } : {})
  }));
}

function errorWithCode(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause !== undefined ? { cause } : {}) });
}

export interface GenerationClaim {
  claimed: boolean;
  attemptId: string;
  existingQuestionsPayload?: unknown;
  existingGenerationSource?: string;
}

// Generation concurrency (socket start_assessment and REST generate are two
// transports the frontend may fire for the same specialty). Lock the parent
// ProviderSpecialty row for one transaction that either returns the existing
// active attempt or reserves a placeholder (status STREAMING, empty
// questionsPayload) BEFORE WaseetAI is called. Callers must already have
// verified ownership of `providerSpecialtyId`.
export async function claimAssessmentGeneration(
  providerSpecialtyId: string,
  providerProfileId: string,
  specialtyId: string
): Promise<GenerationClaim> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM provider_specialties WHERE id = ${providerSpecialtyId} FOR UPDATE`;

    const existing = await tx.assessmentAttempt.findFirst({
      where: { providerSpecialtyId, status: { in: SUBMITTABLE_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, questionsPayload: true, analyzedAssetsSnapshot: true }
    });

    if (existing) {
      const snapshot = existing.analyzedAssetsSnapshot as { generationSource?: string } | null;
      return {
        claimed: false,
        attemptId: existing.id,
        existingQuestionsPayload: existing.questionsPayload,
        existingGenerationSource: typeof snapshot?.generationSource === 'string' ? snapshot.generationSource : undefined
      };
    }

    const reserved = await tx.assessmentAttempt.create({
      data: {
        providerSpecialtyId,
        providerProfileId,
        specialtyId,
        questionsPayload: [],
        totalQuestions: ASSESSMENT_QUESTION_COUNT,
        status: AssessmentStatus.STREAMING,
        timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES,
        startedAt: new Date()
      }
    });

    return { claimed: true, attemptId: reserved.id };
  });
}

async function releaseGenerationClaim(attemptId: string): Promise<void> {
  // Never leave a stuck STREAMING row that would block every future retry.
  await prisma.assessmentAttempt.update({
    where: { id: attemptId },
    data: { status: AssessmentStatus.CANCELLED }
  }).catch(() => {});
}

interface PersistGeneratedInput {
  claimAttemptId: string;
  questions: PublicAssessmentQuestion[];
  vendorAttemptId: string;
  generationSource?: string;
}

// Persists the key-less questions and the WaseetAI attempt id into the
// reserved attempt (existing JSON columns only) and starts our own clock.
async function persistGeneratedAssessment(input: PersistGeneratedInput): Promise<void> {
  await prisma.assessmentAttempt.update({
    where: { id: input.claimAttemptId },
    data: {
      questionsPayload: sanitizeQuestions(input.questions) as any,
      analyzedAssetsSnapshot: {
        provider: 'WASEET_AI',
        vendorAttemptId: input.vendorAttemptId,
        ...(input.generationSource ? { generationSource: input.generationSource } : {})
      } as any,
      totalQuestions: input.questions.length,
      timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES,
      startedAt: new Date(),
      status: AssessmentStatus.IN_PROGRESS
    }
  });
}

export interface StreamedGeneration {
  attemptId: string;
  questions: PublicAssessmentQuestion[];
  totalQuestions: number;
  timeLimitMinutes: number;
  generationSource?: string;
}

/**
 * Streaming generation for the claim winner. `onQuestion` is invoked as each
 * question event arrives from WaseetAI (real relay, no buffering). The
 * questions are persisted only after the stream completes and is validated;
 * on any failure the reservation is released and a coded error is thrown.
 */
export async function streamAssessmentForClaim(input: {
  claimAttemptId: string;
  providerSpecialtyId: string;
  specialtyName: string;
  signal?: AbortSignal;
  onQuestion?: (question: PublicAssessmentQuestion, index: number, total: number) => void;
}): Promise<StreamedGeneration> {
  try {
    const questions: PublicAssessmentQuestion[] = [];
    const vendorAttemptIds = new Set<string>();
    let ready: { attemptId: string; totalQuestions: number; generationSource?: string } | null = null;

    for await (const event of waseetAiClient.streamAssessmentQuestions({
      providerSpecialtyId: input.providerSpecialtyId,
      specialtyName: input.specialtyName,
      questionCount: ASSESSMENT_QUESTION_COUNT,
      timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES
    }, { signal: input.signal })) {
      if (event.type === 'question') {
        vendorAttemptIds.add(event.attemptId);
        const question: PublicAssessmentQuestion = {
          id: event.question.id,
          textAr: event.question.textAr,
          options: event.question.options.map((o) => ({ id: o.id, text: o.text }))
        };
        questions.push(question);
        input.onQuestion?.(question, questions.length, ASSESSMENT_QUESTION_COUNT);
      } else if (event.type === 'assessment_ready') {
        ready = { attemptId: event.attemptId, totalQuestions: event.totalQuestions, generationSource: event.generationSource };
      }
    }

    if (
      !ready || questions.length === 0 || ready.totalQuestions !== questions.length ||
      vendorAttemptIds.size !== 1 || !vendorAttemptIds.has(ready.attemptId)
    ) {
      throw new Error('WaseetAI assessment stream was incomplete or inconsistent');
    }

    await persistGeneratedAssessment({
      claimAttemptId: input.claimAttemptId,
      questions,
      vendorAttemptId: ready.attemptId,
      generationSource: ready.generationSource
    });

    return {
      attemptId: input.claimAttemptId,
      questions,
      totalQuestions: questions.length,
      timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES,
      generationSource: ready.generationSource
    };
  } catch (err) {
    await releaseGenerationClaim(input.claimAttemptId);
    throw errorWithCode(ASSESSMENT_GENERATION_FAILED_MESSAGE, ASSESSMENT_GENERATION_FAILED_CODE, err);
  }
}

// ── Submission ────────────────────────────────────────────────────────────

export type SubmissionOutcome =
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_FINALIZED' }
  | { kind: 'EXPIRED'; completedAt: Date; totalQuestions: number }
  | {
      kind: 'GRADED';
      result: SubmitAssessmentResponse;
      totalQuestions: number;
      gradedBy: 'WASEET_AI' | 'LEGACY_LOCAL_KEY';
      /** Only known for legacy local grading. */
      correctCount?: number;
    };

export const EXPIRED_FEEDBACK_AR = 'انتهت المهلة الزمنية للاختبار (15 دقيقة) قبل تسليم الإجابات.';
export const EXPIRED_WEAKNESS_AR = 'تجاوز الوقت المخصص للاختبار.';

function extractVendorAttemptId(snapshot: unknown): string | null {
  const v = (snapshot as { vendorAttemptId?: unknown } | null)?.vendorAttemptId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readGradingClaimedAt(submittedAnswers: unknown): number | null {
  const raw = (submittedAnswers as { gradingClaimedAt?: unknown } | null)?.gradingClaimedAt;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Review flags ("for review", never an automatic failure): merged into the attempt's existing `analyzedAssetsSnapshot` JSON next to the
 * vendor attempt id, together with the per-answer receive times the server recorded (record_answer). Score and status are untouched.
 */
function snapshotWithReview(attempt: { analyzedAssetsSnapshot?: unknown; startedAt: Date }, questions: StoredQuestion[], answers: Record<string, string>, completedAt: Date) {
  const base = (attempt.analyzedAssetsSnapshot && typeof attempt.analyzedAssetsSnapshot === 'object' && !Array.isArray(attempt.analyzedAssetsSnapshot)
    ? attempt.analyzedAssetsSnapshot : {}) as Record<string, unknown>;
  const answerLog = Array.isArray(base.answerLog) ? (base.answerLog as AnswerLogEntry[]) : [];
  const review = evaluateAssessment({ questionIds: questions.map(q => String(q.id)), answers, startedAt: new Date(attempt.startedAt), completedAt, answerLog });
  return { ...base, review } as any;
}

const MAX_LOGGED_ANSWERS = 100;

/**
 * Records WHEN (server time) the user first answered a question, as the client reports each choice. Best effort and append-only per question:
 * a later change of mind does not move the first-answer time. Returns false when the attempt/question is not valid for this user.
 */
export async function recordAssessmentAnswer(userId: string, attemptId: string, questionId: string, answer: string, now: Date = new Date()): Promise<boolean> {
  if (typeof questionId !== 'string' || typeof answer !== 'string' || !questionId || answer.length > 50) return false;
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.assessmentAttempt.findFirst({
      where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES }, providerSpecialty: { providerProfile: { userId } } },
      select: { id: true, questionsPayload: true, analyzedAssetsSnapshot: true }
    });
    if (!attempt) return false;
    const questions = (Array.isArray(attempt.questionsPayload) ? attempt.questionsPayload : []) as unknown as StoredQuestion[];
    if (!questions.some(q => String(q.id) === questionId)) return false;
    const base = (attempt.analyzedAssetsSnapshot && typeof attempt.analyzedAssetsSnapshot === 'object' && !Array.isArray(attempt.analyzedAssetsSnapshot)
      ? attempt.analyzedAssetsSnapshot : {}) as Record<string, unknown>;
    const log = (Array.isArray(base.answerLog) ? base.answerLog : []) as AnswerLogEntry[];
    if (log.some(e => e.q === questionId) || log.length >= MAX_LOGGED_ANSWERS) return true;
    await tx.assessmentAttempt.update({ where: { id: attempt.id }, data: { analyzedAssetsSnapshot: { ...base, answerLog: [...log, { q: questionId, a: answer, t: now.getTime() }] } as any } });
    return true;
  });
}

function normalizeAnswers(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/**
 * Provider tier from the number of PASSED specialties: >=5 TOP_RATED, >=3 EXPERT, otherwise PRO.
 * (The previous `if (>=3) EXPERT else if (>=5) TOP_RATED` made TOP_RATED unreachable — the larger threshold must be tested first.)
 */
export function tierForVerifiedSpecialties(verifiedCount: number): 'PRO' | 'EXPERT' | 'TOP_RATED' {
  if (verifiedCount >= 5) return 'TOP_RATED';
  if (verifiedCount >= 3) return 'EXPERT';
  return 'PRO';
}

async function applySpecialtyOutcome(
  tx: Prisma.TransactionClient,
  attempt: { providerSpecialtyId: string; providerProfileId: string; providerSpecialty?: { providerProfile?: { userId?: string } } | null },
  score: number,
  isPassed: boolean,
  completedAt: Date
): Promise<void> {
  await tx.providerSpecialty.update({
    where: { id: attempt.providerSpecialtyId },
    data: {
      hasTakenAssessment: true,
      latestScore: score,
      isPassed,
      passedAt: isPassed ? completedAt : null,
      quizScore: score,
      status: isPassed ? SpecialtyVerificationStatus.APPROVED : SpecialtyVerificationStatus.REJECTED,
      badgeGrantedAt: isPassed ? completedAt : null
    }
  });

  const userId = attempt.providerSpecialty?.providerProfile?.userId;
  if (isPassed && userId) {
    const verifiedCount = await tx.providerSpecialty.count({
      where: { providerProfileId: attempt.providerProfileId, isPassed: true }
    });

    const newTier = tierForVerifiedSpecialties(verifiedCount);

    await tx.user.update({ where: { id: userId }, data: { tierLevel: newTier } }).catch(() => {});
  }
}

/**
 * Shared submission pipeline for the REST and socket transports.
 * Ownership -> status -> expiry -> atomic claim -> grading -> persistence.
 *  - Attempts with a WaseetAI attempt id are graded ONLY by WaseetAI. If that
 *    fails the claim is released and an error is thrown; nothing is scored.
 *  - Legacy attempts (local answer key, no vendor id) are graded by a
 *    deterministic local comparison (not AI) with factual feedback.
 */
export async function processAssessmentSubmission(
  attemptId: string,
  userId: string,
  rawAnswers: unknown
): Promise<SubmissionOutcome> {
  const answers = normalizeAnswers(rawAnswers);

  const attempt = await prisma.assessmentAttempt.findFirst({
    where: { id: attemptId, providerSpecialty: { providerProfile: { userId } } },
    include: { providerSpecialty: { include: { specialty: true, providerProfile: true } } }
  });
  if (!attempt) return { kind: 'NOT_FOUND' };
  if (!SUBMITTABLE_STATUSES.includes(attempt.status)) return { kind: 'ALREADY_FINALIZED' };

  const questions = (Array.isArray(attempt.questionsPayload) ? attempt.questionsPayload : []) as unknown as StoredQuestion[];
  const vendorAttemptId = extractVendorAttemptId(attempt.analyzedAssetsSnapshot);
  const totalQuestions = questions.length || attempt.totalQuestions || ASSESSMENT_QUESTION_COUNT;

  // A grading claim that is still fresh means another transport is grading
  // right now; a stale one is abandoned and gets released first.
  if (attempt.submittedAnswers !== null && attempt.submittedAnswers !== undefined) {
    const claimedAt = readGradingClaimedAt(attempt.submittedAnswers);
    if (claimedAt !== null && Date.now() - claimedAt > STALE_GRADING_CLAIM_MS) {
      const released = await prisma.assessmentAttempt.updateMany({
        where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES }, submittedAnswers: { equals: attempt.submittedAnswers as Prisma.InputJsonValue } },
        data: { submittedAnswers: Prisma.DbNull }
      });
      if (released.count === 0) return { kind: 'ALREADY_FINALIZED' };
    } else {
      return { kind: 'ALREADY_FINALIZED' };
    }
  }

  // Timing is owned by this backend: time limit + 1 minute grace.
  const now = new Date();
  const elapsedMs = now.getTime() - new Date(attempt.startedAt).getTime();
  if (elapsedMs / 60000 > attempt.timeLimitMinutes + 1) {
    const expiredClaim = await prisma.assessmentAttempt.updateMany({
      where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES }, submittedAnswers: { equals: Prisma.DbNull } },
      data: { status: AssessmentStatus.EXPIRED, completedAt: now, submittedAnswers: answers as any }
    });
    if (expiredClaim.count === 0) return { kind: 'ALREADY_FINALIZED' };
    return { kind: 'EXPIRED', completedAt: now, totalQuestions };
  }

  if (vendorAttemptId) {
    return gradeWithWaseetAi({ attempt, attemptId, answers, questions, vendorAttemptId, totalQuestions, elapsedMs });
  }
  return gradeLegacyLocally({ attempt, attemptId, answers, questions, totalQuestions });
}

async function gradeWithWaseetAi(ctx: {
  attempt: any; attemptId: string; answers: Record<string, string>; questions: StoredQuestion[];
  vendorAttemptId: string; totalQuestions: number; elapsedMs: number;
}): Promise<SubmissionOutcome> {
  const { attempt, attemptId, answers, questions, vendorAttemptId, totalQuestions, elapsedMs } = ctx;

  // Atomic claim BEFORE calling WaseetAI: the losing transport must never
  // spend a second grading call or overwrite the winner. The marker lives in
  // the existing submittedAnswers column and is only set while it is empty.
  const claim = await prisma.assessmentAttempt.updateMany({
    where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES }, submittedAnswers: { equals: Prisma.DbNull } },
    data: { submittedAnswers: { answers, gradingClaimedAt: new Date().toISOString() } as any }
  });
  if (claim.count === 0) return { kind: 'ALREADY_FINALIZED' };

  const release = () => prisma.assessmentAttempt.updateMany({
    where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES } },
    data: { submittedAnswers: Prisma.DbNull }
  }).catch(() => {});

  // Only answers for known question ids and valid option ids are forwarded.
  const submittedAnswers: Record<string, string> = {};
  for (const q of questions) {
    const raw = answers[String(q.id)];
    if (typeof raw !== 'string') continue;
    const choice = raw.trim().toLowerCase();
    if (q.options.some((o) => o.id === choice)) submittedAnswers[String(q.id)] = choice;
  }
  const limitSeconds = (attempt.timeLimitMinutes + 1) * 60;
  const timeSpentSeconds = Math.max(0, Math.min(limitSeconds, Math.round(elapsedMs / 1000)));

  let graded;
  try {
    graded = await waseetAiClient.submitAssessment(vendorAttemptId, { submittedAnswers, timeSpentSeconds }, { timeoutMs: GRADING_TIMEOUT_MS });
    if (!Number.isFinite(graded.score) || graded.score < 0 || graded.score > 100 || typeof graded.isPassed !== 'boolean') {
      throw new Error('WaseetAI returned an invalid grading result');
    }
  } catch (err) {
    await release();
    throw errorWithCode(ASSESSMENT_GRADING_FAILED_MESSAGE, ASSESSMENT_GRADING_FAILED_CODE, err);
  }

  const score = graded.score;
  const isPassed = graded.isPassed;
  const feedbackAr = typeof graded.feedbackAr === 'string' ? graded.feedbackAr : '';
  const strengths = Array.isArray(graded.strengths) ? graded.strengths.filter((s): s is string => typeof s === 'string') : [];
  const weaknesses = Array.isArray(graded.weaknesses) ? graded.weaknesses.filter((s): s is string => typeof s === 'string') : [];
  const status = isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED;
  const completedAt = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.assessmentAttempt.update({
        where: { id: attemptId },
        data: { submittedAnswers: answers as any, score, isPassed, status, completedAt, feedbackAr, strengths, weaknesses, analyzedAssetsSnapshot: snapshotWithReview(attempt, questions, answers, completedAt) }
      });
      await applySpecialtyOutcome(tx, attempt, score, isPassed, completedAt);
    });
  } catch (err) {
    await release();
    throw errorWithCode(ASSESSMENT_GRADING_FAILED_MESSAGE, ASSESSMENT_GRADING_FAILED_CODE, err);
  }

  return {
    kind: 'GRADED',
    gradedBy: 'WASEET_AI',
    totalQuestions,
    result: { attemptId, score, isPassed, status, feedbackAr, strengths, weaknesses, completedAt }
  };
}

// Pre-integration attempts: deterministic comparison against the stored key.
// This is not AI; feedback is a factual statement of the outcome only.
async function gradeLegacyLocally(ctx: {
  attempt: any; attemptId: string; answers: Record<string, string>; questions: StoredQuestion[]; totalQuestions: number;
}): Promise<SubmissionOutcome> {
  const { attempt, attemptId, answers, questions, totalQuestions } = ctx;

  if (questions.length === 0 || !questions.every((q) => typeof q.correctAnswer === 'string' && q.correctAnswer.length > 0)) {
    throw errorWithCode('لا يمكن تصحيح هذه المحاولة لعدم توفر بيانات التصحيح.', ASSESSMENT_NOT_GRADABLE_CODE);
  }

  let correctCount = 0;
  for (const q of questions) {
    const choice = answers[String(q.id)];
    if (choice && choice.trim().toLowerCase() === (q.correctAnswer as string).trim().toLowerCase()) correctCount++;
  }

  const score = parseFloat(((correctCount / totalQuestions) * 100).toFixed(1));
  const isPassed = score > 25.0; // legacy rule, applies only to pre-WaseetAI attempts
  const status = isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED;
  const completedAt = new Date();

  const claim = await prisma.assessmentAttempt.updateMany({
    where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES } },
    data: { submittedAnswers: answers as any, score, isPassed, status, completedAt, analyzedAssetsSnapshot: snapshotWithReview(attempt, questions, answers, completedAt) }
  });
  if (claim.count === 0) return { kind: 'ALREADY_FINALIZED' };

  const specialtyNameAr = attempt.providerSpecialty?.specialty?.nameAr || 'التخصص الفني';
  const feedbackAr = isPassed
    ? `تم اجتياز تقييم تخصص (${specialtyNameAr}) بنسبة ${score}% (${correctCount}/${totalQuestions}).`
    : `لم تتجاوز نسبة الاجتياز المطلوبة (25%) في تخصص (${specialtyNameAr}) - النتيجة: ${score}% (${correctCount}/${totalQuestions}).`;
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  await prisma.$transaction(async (tx) => {
    await tx.assessmentAttempt.update({ where: { id: attemptId }, data: { feedbackAr, strengths, weaknesses } });
    await applySpecialtyOutcome(tx, attempt, score, isPassed, completedAt);
  });

  return {
    kind: 'GRADED',
    gradedBy: 'LEGACY_LOCAL_KEY',
    totalQuestions,
    correctCount,
    result: { attemptId, score, isPassed, status, feedbackAr, strengths, weaknesses, completedAt }
  };
}

export class AiAssessmentService {

  /**
   * 1. Question generation via WaseetAI (POST /api/assessments/generate)
   */
  async generateAssessment(providerSpecialtyId: string, currentUserId: string): Promise<GenerateAssessmentResponse> {
    const providerSpecialty = await prisma.providerSpecialty.findFirst({
      where: { id: providerSpecialtyId, providerProfile: { userId: currentUserId } },
      select: {
        id: true,
        specialtyId: true,
        providerProfileId: true,
        specialty: { select: { nameAr: true, name: true } }
      }
    });

    if (!providerSpecialty) {
      throw new Error(`ProviderSpecialty with ID '${providerSpecialtyId}' was not found.`);
    }

    const specialtyName = providerSpecialty.specialty?.nameAr || providerSpecialty.specialty?.name || 'التخصص الفني';

    // Claim BEFORE calling WaseetAI. If the socket twin (or a duplicate REST
    // retry) already owns an active attempt, reuse its real result.
    const claim = await claimAssessmentGeneration(providerSpecialtyId, providerSpecialty.providerProfileId, providerSpecialty.specialtyId);

    if (!claim.claimed) {
      const existing = (Array.isArray(claim.existingQuestionsPayload) ? claim.existingQuestionsPayload : []) as StoredQuestion[];
      if (existing.length > 0) {
        return {
          attemptId: claim.attemptId,
          questions: sanitizeQuestions(existing),
          timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES,
          ...(claim.existingGenerationSource ? { generationSource: claim.existingGenerationSource } : {})
        };
      }
      throw errorWithCode('Assessment generation is already in progress for this specialty.', 'GENERATION_IN_PROGRESS');
    }

    try {
      const created = await waseetAiClient.createAssessment({
        providerSpecialtyId,
        specialtyName,
        questionCount: ASSESSMENT_QUESTION_COUNT,
        timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES
      });

      const questions: PublicAssessmentQuestion[] = (created.questions || []).map((q) => ({
        id: q.id,
        textAr: q.textAr,
        options: (q.options || []).map((o) => ({ id: o.id, text: o.text }))
      }));
      if (questions.length === 0 || !created.attemptId) {
        throw new Error('WaseetAI returned an empty assessment');
      }

      await persistGeneratedAssessment({ claimAttemptId: claim.attemptId, questions, vendorAttemptId: created.attemptId });

      return { attemptId: claim.attemptId, questions, timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES };
    } catch (err) {
      await releaseGenerationClaim(claim.attemptId);
      throw errorWithCode(ASSESSMENT_GENERATION_FAILED_MESSAGE, ASSESSMENT_GENERATION_FAILED_CODE, err);
    }
  }

  /**
   * 2. Submission & grading (POST /api/assessments/:attemptId/submit)
   */
  async submitAssessment(attemptId: string, submittedAnswers: Record<string, string>, currentUserId?: string): Promise<SubmitAssessmentResponse> {
    if (!currentUserId) {
      throw new Error(`Assessment attempt '${attemptId}' was not found.`);
    }

    const outcome = await processAssessmentSubmission(attemptId, currentUserId, submittedAnswers);

    switch (outcome.kind) {
      case 'NOT_FOUND':
        throw new Error(`Assessment attempt '${attemptId}' was not found.`);
      case 'ALREADY_FINALIZED':
        throw new Error(`Assessment attempt '${attemptId}' was already finalized.`);
      case 'EXPIRED':
        return {
          attemptId,
          score: 0,
          isPassed: false,
          status: AssessmentStatus.EXPIRED,
          feedbackAr: EXPIRED_FEEDBACK_AR,
          strengths: [],
          weaknesses: [EXPIRED_WEAKNESS_AR],
          completedAt: outcome.completedAt
        };
      default:
        return outcome.result;
    }
  }

  /**
   * 3. Get Attempt Status / Details (GET /api/assessments/:attemptId/status)
   */
  async getAttemptStatus(attemptId: string, currentUserId?: string) {
    const attempt = await prisma.assessmentAttempt.findUnique({
      where: { id: attemptId },
      include: {
        specialty: { select: { id: true, nameAr: true, nameEn: true } },
        providerSpecialty: {
          select: {
            id: true,
            status: true,
            isPassed: true,
            latestScore: true,
            providerProfile: { select: { userId: true } }
          }
        }
      }
    });

    if (!attempt || !currentUserId || attempt.providerSpecialty?.providerProfile.userId !== currentUserId) {
      // Missing, or not owned by the caller (never reveal which): a plain 404 — not a 500.
      throw new AppError('محاولة التقييم غير موجودة', 404);
    }

    const { providerProfile: _providerProfile, ...safeProviderSpecialty } = attempt.providerSpecialty;
    // Never expose a (legacy) answer key through the status endpoint.
    const questionsPayload = Array.isArray(attempt.questionsPayload)
      ? sanitizeQuestions(attempt.questionsPayload as unknown as StoredQuestion[])
      : attempt.questionsPayload;
    return { ...attempt, questionsPayload, providerSpecialty: safeProviderSpecialty };
  }
}

export const aiAssessmentService = new AiAssessmentService();
