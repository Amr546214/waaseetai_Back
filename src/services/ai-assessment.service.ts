import { AssessmentStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { geminiClient } from './ai/gemini/gemini.client';
import { aiAssessmentAnalyzerService, AssessmentQuestion } from './ai-assessment-analyzer.service';

// F12 — AI Assessment REST. Batch report finding: this service's OWN
// question-generation prompt/OpenAI call and its OWN `getFallbackQuestions()`
// static bank were dead code — `generateAssessment()` always delegated
// actual generation to `aiAssessmentAnalyzerService.generate20Questions()`,
// whose own internal fallback guarantees a non-empty 20-question result, so
// `!generatedQuestions.length` could never be true. Both are removed here;
// this file now converges entirely on the shared analyzer service (the same
// one F14's socket flow uses), per the canonical-schema consolidation this
// batch requires. Only the feedback-synthesis call (submitAssessment) is
// this file's own Gemini call, migrated from OpenAI below.
//
// F12's distinct legitimate use: the frontend (specialties.ts) treats F14's
// socket stream as primary and calls this REST endpoint only as a 3.5s
// timeout fallback if the socket hasn't delivered a question yet — a real,
// reachable, distinct use case, not a redundant duplicate. Retained.

export interface GenerateAssessmentResponse {
  attemptId: string;
  questions: Omit<AssessmentQuestion, 'correctAnswer' | 'explanation'>[];
  timeLimitMinutes: number;
  generationSource: 'GEMINI' | 'STATIC_FALLBACK';
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

// Batch 3D-1 — assessment submission integrity. `submitAssessment` (REST) and
// `assessment.gateway.ts::handleSubmission` (socket) are two independent
// transports that can both be invoked for the same attemptId essentially in
// parallel (specialties.ts fires both on every submit). Only an attempt still
// in one of these statuses may be finalized; the finalizing write below is an
// atomic `updateMany` conditioned on this same list at write time (not just
// at the initial read), so a concurrent finalization can never be overwritten
// — whichever request's updateMany matches zero rows lost the race and must
// not proceed to score/Gemini/ProviderSpecialty work.
const SUBMITTABLE_STATUSES: AssessmentStatus[] = [AssessmentStatus.IN_PROGRESS, AssessmentStatus.STREAMING];

const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    feedbackAr: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } }
  },
  required: ['feedbackAr', 'strengths', 'weaknesses']
};

function isValidFeedback(value: unknown): value is { feedbackAr: string; strengths: string[]; weaknesses: string[] } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.feedbackAr === 'string' && v.feedbackAr.trim().length > 0 &&
    Array.isArray(v.strengths) && v.strengths.every((s) => typeof s === 'string') &&
    Array.isArray(v.weaknesses) && v.weaknesses.every((s) => typeof s === 'string')
  );
}

// Strip correctAnswer/explanation before sending to the frontend — shared by
// both the fresh-generation path and the claim-reuse path below.
function sanitizeQuestions(questions: AssessmentQuestion[]): Omit<AssessmentQuestion, 'correctAnswer' | 'explanation'>[] {
  return questions.map(q => ({
    id: q.id,
    textAr: q.textAr,
    options: q.options.map(opt => ({ id: opt.id, text: opt.text })),
    assessmentArea: q.assessmentArea
  }));
}

interface GenerationClaim {
  claimed: boolean;
  attemptId: string;
  existingQuestionsPayload?: unknown;
  existingGenerationSource?: 'GEMINI' | 'STATIC_FALLBACK';
}

// Batch 3D-2 — generation concurrency. The socket (`assessment.gateway.ts`
// start_assessment) and REST (`generateAssessment` below) generation paths
// are two independent transports the frontend fires for the same
// providerSpecialtyId, racing whenever Gemini's ~20-question generation
// exceeds the frontend's 3.5s fallback timer (specialties.ts). Neither path
// previously checked for an existing active attempt before spending a Gemini
// call, so both could generate concurrently and create two AssessmentAttempt
// rows for one specialty. A plain findFirst-then-create is not
// concurrency-safe (the read and the write are not one atomic operation).
//
// Fix: lock the parent ProviderSpecialty row (`SELECT ... FOR UPDATE` on its
// existing primary key — no schema change) for the duration of a single
// transaction that checks for an active attempt and, if none exists, reserves
// a new placeholder row (status STREAMING, empty questionsPayload — a valid
// value for this required Json column) BEFORE Gemini is ever called. Callers
// must have already verified ownership of `providerSpecialtyId` before
// calling this (same as the pre-existing per-transport ownership checks) —
// this function does not re-check ownership itself, only serializes
// concurrent generation attempts for an already-authorized specialty.
async function claimAssessmentGeneration(
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
      const snapshot = existing.analyzedAssetsSnapshot as { generationSource?: 'GEMINI' | 'STATIC_FALLBACK' } | null;
      return {
        claimed: false,
        attemptId: existing.id,
        existingQuestionsPayload: existing.questionsPayload,
        existingGenerationSource: snapshot?.generationSource
      };
    }

    const reserved = await tx.assessmentAttempt.create({
      data: {
        providerSpecialtyId,
        providerProfileId,
        specialtyId,
        questionsPayload: [],
        totalQuestions: 20,
        status: AssessmentStatus.STREAMING,
        timeLimitMinutes: 15,
        startedAt: new Date()
      }
    });

    return { claimed: true, attemptId: reserved.id };
  });
}

export class AiAssessmentService {

  /**
   * 1. Dynamic Question Generation (POST /api/assessments/generate)
   */
  async generateAssessment(providerSpecialtyId: string, currentUserId: string): Promise<GenerateAssessmentResponse> {
    // 1. Fetch provider specialty details with specialty, category, and work samples
    const providerSpecialty = await prisma.providerSpecialty.findFirst({
      where: { id: providerSpecialtyId, providerProfile: { userId: currentUserId } },
      include: {
        specialty: {
          include: { category: true }
        },
        providerProfile: {
          include: {
            user: true,
            portfolioItems: true,
            certificates: true
          }
        },
        workSamples: {
          include: { proofs: true }
        }
      }
    });

    if (!providerSpecialty) {
      throw new Error(`ProviderSpecialty with ID '${providerSpecialtyId}' was not found.`);
    }

    const specialty = providerSpecialty.specialty;
    const specialtyNameAr = specialty.nameAr || specialty.name || 'التخصص الفني';
    const categoryName = specialty.category?.nameAr || '';
    const subSpecialties = providerSpecialty.subSpecialties || [];

    // 2. Claim generation for this specialty BEFORE calling Gemini. If the
    // socket twin (or a duplicate REST retry) already owns an active attempt,
    // reuse its real result instead of spending a second Gemini call.
    const claim = await claimAssessmentGeneration(providerSpecialtyId, providerSpecialty.providerProfileId, providerSpecialty.specialtyId);

    if (!claim.claimed) {
      const existingQuestions = (claim.existingQuestionsPayload as AssessmentQuestion[]) || [];
      if (existingQuestions.length > 0) {
        return {
          attemptId: claim.attemptId,
          questions: sanitizeQuestions(existingQuestions),
          timeLimitMinutes: 15,
          generationSource: claim.existingGenerationSource || 'GEMINI'
        };
      }

      const inProgressError: any = new Error('Assessment generation is already in progress for this specialty.');
      inProgressError.code = 'GENERATION_IN_PROGRESS';
      throw inProgressError;
    }

    // 3. Generate — only the claim winner reaches this point.
    let generatedQuestions: AssessmentQuestion[];
    let subSpecialtiesSnapshot: string[];
    let analyzedAssetsSnapshot: any[];
    let generationSource: 'GEMINI' | 'STATIC_FALLBACK';
    try {
      ({ questions: generatedQuestions, subSpecialtiesSnapshot, analyzedAssetsSnapshot, generationSource } =
        await aiAssessmentAnalyzerService.generate20Questions({
          providerSpecialtyId,
          specialtyId: providerSpecialty.specialtyId,
          subSpecialties,
          categoryName,
          specialtyName: specialtyNameAr,
          providerProfileId: providerSpecialty.providerProfileId
        }));

      // 4. Fill in the reserved attempt with the real snapshot metadata
      // (including the honest generation source) — never discarded.
      await prisma.assessmentAttempt.update({
        where: { id: claim.attemptId },
        data: {
          subSpecialtiesSnapshot: subSpecialtiesSnapshot as any,
          analyzedAssetsSnapshot: { items: analyzedAssetsSnapshot, generationSource } as any,
          questionsPayload: generatedQuestions as any,
          status: AssessmentStatus.IN_PROGRESS
        }
      });
    } catch (err) {
      // Release the reservation so a retry is never permanently blocked by a
      // stuck STREAMING row (Batch 3D-2 failure-recovery requirement).
      await prisma.assessmentAttempt.update({
        where: { id: claim.attemptId },
        data: { status: AssessmentStatus.CANCELLED }
      }).catch(() => {});
      throw err;
    }

    return {
      attemptId: claim.attemptId,
      questions: sanitizeQuestions(generatedQuestions),
      timeLimitMinutes: 15,
      generationSource
    };
  }

  /**
   * 2. Submission & AI Evaluation (POST /api/assessments/:attemptId/submit)
   */
  async submitAssessment(attemptId: string, submittedAnswers: Record<string, string>, currentUserId?: string): Promise<SubmitAssessmentResponse> {
    const attempt = await prisma.assessmentAttempt.findUnique({
      where: { id: attemptId },
      include: {
        providerSpecialty: {
          include: {
            specialty: true,
            providerProfile: { include: { user: true } }
          }
        }
      }
    });

    if (!attempt || !currentUserId || attempt.providerSpecialty.providerProfile.userId !== currentUserId) {
      throw new Error(`Assessment attempt '${attemptId}' was not found.`);
    }

    if (!SUBMITTABLE_STATUSES.includes(attempt.status)) {
      throw new Error(`Assessment attempt '${attemptId}' is already ${attempt.status}.`);
    }

    // 1. Time limit validation (15 minutes limit with 1 minute grace period for network latency)
    const now = new Date();
    const elapsedMinutes = (now.getTime() - new Date(attempt.startedAt).getTime()) / (1000 * 60);
    const isExpired = elapsedMinutes > (attempt.timeLimitMinutes + 1);

    if (isExpired) {
      // Atomic claim: only matches if the attempt is still submittable at
      // write time, not merely at the read above — closes the race window
      // against a concurrent socket/REST finalization (Batch 3D-1).
      const expiredClaim = await prisma.assessmentAttempt.updateMany({
        where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES } },
        data: {
          status: AssessmentStatus.EXPIRED,
          completedAt: now,
          submittedAnswers: submittedAnswers as any
        }
      });

      if (expiredClaim.count === 0) {
        throw new Error(`Assessment attempt '${attemptId}' was already finalized by a concurrent submission.`);
      }

      return {
        attemptId,
        score: 0,
        isPassed: false,
        status: AssessmentStatus.EXPIRED,
        feedbackAr: 'انتهت المهلة الزمنية للاختبار (15 دقيقة) قبل تسليم الإجابات.',
        strengths: [],
        weaknesses: ['تجاوز الوقت المخصص للاختبار.'],
        completedAt: now
      };
    }

    // 2. Score Calculation
    const questionsPayload = (attempt.questionsPayload as unknown as AssessmentQuestion[]) || [];
    let correctCount = 0;
    const totalQuestions = questionsPayload.length || 5;

    questionsPayload.forEach((q) => {
      const qKey = String(q.id);
      const userSelected = submittedAnswers[qKey] || submittedAnswers[q.id as any];
      if (userSelected && q.correctAnswer && userSelected.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase()) {
        correctCount++;
      }
    });

    const scorePercentage = parseFloat(((correctCount / totalQuestions) * 100).toFixed(1));
    const isPassed = scorePercentage > 25.0;

    // Claim the attempt BEFORE calling Gemini (Batch 3D-1): a losing
    // concurrent request (the socket twin, or a duplicate REST retry) must
    // never spend a Gemini call or overwrite the winner's result. Same
    // atomic-updateMany pattern as the expiry branch above.
    const completedAt = new Date();
    const claim = await prisma.assessmentAttempt.updateMany({
      where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES } },
      data: {
        submittedAnswers: submittedAnswers as any,
        score: scorePercentage,
        isPassed,
        status: isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED,
        completedAt
      }
    });

    if (claim.count === 0) {
      throw new Error(`Assessment attempt '${attemptId}' was already finalized by a concurrent submission.`);
    }

    // 3. AI Feedback Generation via the shared Gemini foundation. Honest
    // failure: on any Gemini error or malformed output, the pre-computed
    // deterministic feedback strings (already real — derived from the
    // actual pass/fail outcome, not fabricated) are used as-is, never a
    // silently-patched partial result.
    const specialtyNameAr = attempt.providerSpecialty?.specialty?.nameAr || 'التخصص الفني';
    let feedbackAr = isPassed
      ? `ممتاز! أظهرت كفاءة عالية وفهماً دقيقاً في تخصص (${specialtyNameAr}) بنسبة نجاح ${scorePercentage}%.`
      : `لم تتجاوز نسبة الاجتياز المطلوبة (25%) في تخصص (${specialtyNameAr}) - النتيجة: ${scorePercentage}%. يُنصح بمراجعة المفاهيم التقنية وإعادة المحاولة.`;
    let strengths: string[] = isPassed
      ? ['إلمام ممتاز بالمعايير التقنية وأنماط التصميم المستقرة.', 'قدرة على تحليل السيناريوهات المعقدة واختيار الحلول المثلى.']
      : ['رغبة ومبادرة جيدة في خوض تقييم الكفاءة الفنية.'];
    let weaknesses: string[] = isPassed
      ? []
      : ['الحاجة لتعميق الفهم في أفضل الممارسات الأمنية وهندسة الأنظمة.', 'تسرع في اختيار بعض الخيارات التقنية المركبة.'];

    try {
      const feedbackPrompt = `بصفتك كبير مقيمي وسيط AI، قم بتحليل نتيجة اختبار التخصص التالي:
التخصص: ${specialtyNameAr}
الدرجة: ${scorePercentage}% (${correctCount}/${totalQuestions})
حالة الاجتياز: ${isPassed ? 'تم الاجتياز' : 'لم يجتز'}
الأسئلة والإجابات: ${JSON.stringify(questionsPayload.map(q => ({
        question: q.textAr,
        userAnswer: submittedAnswers[String(q.id)],
        correctAnswer: q.correctAnswer,
        explanation: q.explanation
      })))}`;

      const result = await geminiClient.generateStructured<{ feedbackAr: string; strengths: string[]; weaknesses: string[] }>(feedbackPrompt, {
        systemInstruction: 'أنت محرك تقييم ذكي ومحلل كفاءات فنية لمنصة وسيط AI.',
        responseSchema: FEEDBACK_SCHEMA,
        validate: isValidFeedback,
        temperature: 0.3,
        // Live-Gemini testing found 500 truncated this feedbackAr +
        // strengths[] + weaknesses[] response once gemini-flash-latest's
        // variable reasoning-token overhead is accounted for. Raised with
        // headroom (kept in sync with the socket twin in
        // sockets/assessment.gateway.ts).
        maxOutputTokens: 1000
      });

      feedbackAr = result.data.feedbackAr;
      strengths = result.data.strengths;
      weaknesses = result.data.weaknesses;
    } catch (err) {
      console.warn('[AiAssessmentService] Gemini feedback generation unavailable, using deterministic real-outcome feedback:', (err as any)?.code || (err as Error)?.message);
    }

    // 4. Persist feedback + ProviderSpecialty outcome. The claim above
    // already won this attempt exclusively (score/status/completedAt are
    // already committed), so this transaction only adds the feedback text
    // and the downstream ProviderSpecialty/tier effects.
    await prisma.$transaction(async (tx) => {
      await tx.assessmentAttempt.update({
        where: { id: attemptId },
        data: { feedbackAr, strengths, weaknesses }
      });

      await tx.providerSpecialty.update({
        where: { id: attempt.providerSpecialtyId },
        data: {
          hasTakenAssessment: true,
          latestScore: scorePercentage,
          isPassed,
          passedAt: isPassed ? completedAt : null,
          quizScore: scorePercentage,
          status: isPassed ? SpecialtyVerificationStatus.APPROVED : SpecialtyVerificationStatus.REJECTED,
          badgeGrantedAt: isPassed ? completedAt : null
        }
      });

      // Update User tierLevel if passed
      if (isPassed && attempt.providerSpecialty?.providerProfile?.userId) {
        const userId = attempt.providerSpecialty.providerProfile.userId;
        const verifiedCount = await tx.providerSpecialty.count({
          where: {
            providerProfileId: attempt.providerProfileId,
            isPassed: true
          }
        });

        let newTier = 'PRO';
        if (verifiedCount >= 3) newTier = 'EXPERT';
        else if (verifiedCount >= 5) newTier = 'TOP_RATED';

        await tx.user.update({
          where: { id: userId },
          data: { tierLevel: newTier }
        }).catch(() => {});
      }
    });

    return {
      attemptId,
      score: scorePercentage,
      isPassed,
      status: isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED,
      feedbackAr,
      strengths,
      weaknesses,
      completedAt
    };
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
      throw new Error(`Assessment attempt '${attemptId}' not found.`);
    }

    const { providerProfile: _providerProfile, ...safeProviderSpecialty } = attempt.providerSpecialty;
    return { ...attempt, providerSpecialty: safeProviderSpecialty };
  }
}

export const aiAssessmentService = new AiAssessmentService();
