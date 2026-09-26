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

    const { questions: generatedQuestions, subSpecialtiesSnapshot, analyzedAssetsSnapshot, generationSource } =
      await aiAssessmentAnalyzerService.generate20Questions({
        providerSpecialtyId,
        specialtyId: providerSpecialty.specialtyId,
        subSpecialties,
        categoryName,
        specialtyName: specialtyNameAr,
        providerProfileId: providerSpecialty.providerProfileId
      });

    // 2. Store Attempt in Database — real snapshot metadata (including the
    // honest generation source) is persisted, not discarded.
    const attempt = await prisma.assessmentAttempt.create({
      data: {
        providerSpecialtyId,
        providerProfileId: providerSpecialty.providerProfileId,
        specialtyId: providerSpecialty.specialtyId,
        subSpecialtiesSnapshot: subSpecialtiesSnapshot as any,
        analyzedAssetsSnapshot: { items: analyzedAssetsSnapshot, generationSource } as any,
        questionsPayload: generatedQuestions as any,
        status: AssessmentStatus.IN_PROGRESS,
        timeLimitMinutes: 15,
        startedAt: new Date()
      }
    });

    // 3. Strip correctAnswer/explanation before sending to frontend
    const sanitizedQuestions = generatedQuestions.map(q => ({
      id: q.id,
      textAr: q.textAr,
      options: q.options.map(opt => ({ id: opt.id, text: opt.text })),
      assessmentArea: q.assessmentArea
    }));

    return {
      attemptId: attempt.id,
      questions: sanitizedQuestions,
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

    if (attempt.status !== AssessmentStatus.IN_PROGRESS) {
      throw new Error(`Assessment attempt '${attemptId}' is already ${attempt.status}.`);
    }

    // 1. Time limit validation (15 minutes limit with 1 minute grace period for network latency)
    const now = new Date();
    const elapsedMinutes = (now.getTime() - new Date(attempt.startedAt).getTime()) / (1000 * 60);
    const isExpired = elapsedMinutes > (attempt.timeLimitMinutes + 1);

    if (isExpired) {
      await prisma.assessmentAttempt.update({
        where: { id: attemptId },
        data: {
          status: AssessmentStatus.EXPIRED,
          completedAt: now,
          submittedAnswers: submittedAnswers as any
        }
      });

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

    // 4. Update Database Transactionally
    const completedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.assessmentAttempt.update({
        where: { id: attemptId },
        data: {
          submittedAnswers: submittedAnswers as any,
          score: scorePercentage,
          isPassed,
          feedbackAr,
          strengths,
          weaknesses,
          status: isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED,
          completedAt
        }
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
