import { Socket, Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/db';
import { AssessmentStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { aiAssessmentAnalyzerService, AssessmentQuestion } from '../services/ai-assessment-analyzer.service';
import { geminiClient } from '../services/ai/gemini/gemini.client';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// F14 — live primary assessment socket flow, migrated to the shared Gemini
// foundation via the same `aiAssessmentAnalyzerService` F12 uses (canonical
// schema convergence — see the Batch report's caller graph).
//
// Security fixes this batch (Batch: F12+F13+F14 assessment pipeline):
// 1. `submit_answer`/`submit_assessment` previously fetched the attempt by
//    `attemptId` alone, with NO check that the calling socket's user
//    actually owns that attempt — any authenticated socket that learned or
//    guessed another user's attemptId could submit answers on their behalf
//    and affect their real ProviderSpecialty status/score. Fixed: the DB
//    lookup now filters on `providerSpecialty.providerProfile.userId`.
// 2. Zero rate limiting existed on any of these events. Fixed: reuses the
//    shared `socket-ai-rate-limit.ts` from the F1/F2 batch — no new limiter.
// 3. `start_assessment` already required `socket.userId` — preserved
//    unchanged. See the Batch report for a separate, critical finding: the
//    real frontend caller (anti-cheat.service.ts) never actually supplied a
//    token for this socket connection, meaning `socket.userId` likely never
//    populated for real users — fixed on the frontend side (see report).

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

// Batch 3D-1 — assessment submission integrity. This socket path and the REST
// twin (ai-assessment.service.ts::submitAssessment) are two independent
// transports the frontend fires essentially in parallel for the same
// attemptId (specialties.ts). Only an attempt still in one of these statuses
// may be finalized; the finalizing write below is an atomic `updateMany`
// conditioned on this same list at write time (not just at the initial
// read), so a concurrent finalization on either transport can never be
// overwritten — whichever request's updateMany matches zero rows lost the
// race and must not proceed to score/Gemini/ProviderSpecialty work. Kept in
// sync with the identical list + expiry semantics in ai-assessment.service.ts.
const SUBMITTABLE_STATUSES: AssessmentStatus[] = [AssessmentStatus.IN_PROGRESS, AssessmentStatus.STREAMING];
const ALREADY_FINALIZED_MESSAGE = 'تم تسليم وتقييم محاولة التقييم هذه مسبقاً.';
const GENERATION_IN_PROGRESS_MESSAGE = 'التقييم قيد التوليد بالفعل، يرجى الانتظار.';

// Batch 3D-3 — structured error codes for handleSubmission's assessment_error
// emissions only (start_assessment/generation is untouched — out of scope).
// The frontend's submission-transport consolidation needs to distinguish a
// genuine retryable transport/processing failure (SUBMISSION_FAILED) from a
// terminal business outcome (everything else) without parsing the
// human-readable Arabic message. This is additive — `message` is unchanged
// on every emission, `code` is a new field alongside it.
const SUBMIT_ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_FINALIZED: 'ALREADY_FINALIZED',
  SUBMISSION_FAILED: 'SUBMISSION_FAILED'
} as const;

interface GenerationClaim {
  claimed: boolean;
  attemptId: string;
  existingQuestionsPayload?: unknown;
  existingGenerationSource?: 'GEMINI' | 'STATIC_FALLBACK';
}

// Batch 3D-2 — generation concurrency. This socket path (`start_assessment`)
// and the REST twin (ai-assessment.service.ts::generateAssessment) are two
// independent transports the frontend fires for the same providerSpecialtyId,
// racing whenever Gemini's ~20-question generation exceeds the frontend's
// 3.5s fallback timer (specialties.ts). Neither path previously checked for
// an existing active attempt before spending a Gemini call. Fix: lock the
// parent ProviderSpecialty row (`SELECT ... FOR UPDATE` on its existing
// primary key — no schema change) for one transaction that checks for an
// active attempt and, if none exists, reserves a new placeholder row (status
// STREAMING, empty questionsPayload) BEFORE Gemini is called. Kept in sync
// with the identical function in ai-assessment.service.ts. Callers must
// already have verified ownership of providerSpecialtyId.
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

export class AssessmentGateway {
  private io: SocketIOServer | null = null;

  public register(socket: Socket, io?: SocketIOServer): void {
    if (io) this.io = io;

    /**
     * Event: start_assessment (or assessment:start)
     * Initializes a dynamic 20-question AI assessment session and streams questions 1 by 1
     */
    socket.on('start_assessment', async (payload: {
      providerSpecialtyId?: string;
      specialtyId?: string;
      subSpecialtyIds?: string[];
      portfolioFileUrls?: string[];
      categoryName?: string;
      specialtyName?: string;
      providerProfileId?: string;
    }) => {
      console.log(`[AssessmentGateway] Client ${socket.id} started assessment stream:`, payload);

      const userId = (socket as any).userId as string | undefined;
      const providerSpecId = payload.providerSpecialtyId;
      if (!userId || !providerSpecId) {
        socket.emit('assessment_error', { message: 'بيانات المصادقة والتخصص مطلوبة.' });
        return;
      }

      if (isSocketAiRateLimited(userId)) {
        socket.emit('assessment_error', { message: SOCKET_AI_RATE_LIMIT_MESSAGE });
        return;
      }

      const providerSpecialty = await prisma.providerSpecialty.findFirst({
        where: { id: providerSpecId, providerProfile: { userId } },
        select: { id: true, specialtyId: true, providerProfileId: true, subSpecialties: true }
      });
      if (!providerSpecialty) {
        socket.emit('assessment_error', { message: 'التخصص غير موجود أو لا تملك صلاحية الوصول إليه.' });
        return;
      }

      const specId = providerSpecialty.specialtyId;
      const profileId = providerSpecialty.providerProfileId;

      // Claim generation for this specialty BEFORE calling Gemini (Batch
      // 3D-2). If the REST twin (or a duplicate socket retry) already owns
      // an active attempt, reuse its real result instead of spending a
      // second Gemini call. A claim failure (e.g. DB unavailable) degrades
      // to the pre-existing unprotected in-memory mode — same resilience
      // characteristic as before this batch, just without duplicate-safety.
      let claim: GenerationClaim | null = null;
      try {
        claim = await claimAssessmentGeneration(providerSpecId, profileId, specId);
      } catch (claimErr) {
        console.warn('[AssessmentGateway] Generation claim failed, falling back to unprotected in-memory generation:', claimErr);
      }

      if (claim && !claim.claimed) {
        const existingQuestions = (claim.existingQuestionsPayload as AssessmentQuestion[]) || [];
        if (existingQuestions.length === 0) {
          // Generation is genuinely in flight elsewhere for this specialty —
          // no real questions exist yet to replay.
          socket.emit('assessment_error', { message: GENERATION_IN_PROGRESS_MESSAGE });
          return;
        }

        // Generation already finished elsewhere — replay the real,
        // already-generated questions to this caller instead of regenerating.
        for (let i = 0; i < existingQuestions.length; i++) {
          const rawQ = existingQuestions[i];
          const sanitizedQuestion = {
            id: rawQ.id,
            textAr: rawQ.textAr,
            options: rawQ.options.map(opt => ({ id: opt.id, text: opt.text })),
            timeLimitSeconds: rawQ.timeLimitSeconds || 45,
            difficulty: rawQ.assessmentArea || rawQ.difficulty || (i < 5 ? 'التخصص الرئيسي' : (i < 10 ? 'التخصص الفرعي' : (i < 15 ? 'نموذج العمل والتقنيات' : 'مهارات العميل والصفقات')))
          };
          socket.emit('question_streamed', {
            attemptId: claim.attemptId,
            questionIndex: i + 1,
            totalQuestions: existingQuestions.length,
            question: sanitizedQuestion
          });
        }

        socket.emit('assessment_ready', {
          attemptId: claim.attemptId,
          totalQuestions: existingQuestions.length,
          timeLimitMinutes: 15,
          generationSource: claim.existingGenerationSource || 'GEMINI',
          message: '✓ تم اكتمال بث أسئلة الاختبار الـ 20 بنجاح عبر الذكاء الاصطناعي.'
        });
        return;
      }

      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);

      // A real reserved row exists only when the claim above succeeded.
      const attemptId = claim?.claimed ? claim.attemptId : `attempt-${Date.now()}`;

      try {
        // 1. Analyze specialty, sub-specialties, and portfolio files to generate 20 questions
        const { questions, subSpecialtiesSnapshot, analyzedAssetsSnapshot, generationSource } =
          await aiAssessmentAnalyzerService.generate20Questions({
            providerSpecialtyId: providerSpecId,
            specialtyId: specId,
            subSpecialties: payload.subSpecialtyIds,
            portfolioFileUrls: payload.portfolioFileUrls,
            categoryName: payload.categoryName,
            specialtyName: payload.specialtyName,
            providerProfileId: profileId,
            signal: abortController.signal
          });

        // 2. Fill in the reserved AssessmentAttempt with the real generated
        // data. The row itself was already created (status STREAMING) by the
        // claim above, before Gemini ran.
        if (claim?.claimed) {
          try {
            await prisma.assessmentAttempt.update({
              where: { id: attemptId },
              data: {
                subSpecialtiesSnapshot: subSpecialtiesSnapshot as any,
                analyzedAssetsSnapshot: { items: analyzedAssetsSnapshot, generationSource } as any,
                questionsPayload: questions as any
              }
            });
          } catch (persistErr) {
            // The reservation is now stuck with no real data — release it
            // (Batch 3D-2 failure-recovery requirement) rather than leaving a
            // permanently-active row that blocks every future retry for this
            // specialty, and report a real error instead of silently
            // streaming unpersisted questions from a claimed-but-orphaned row.
            await prisma.assessmentAttempt.update({
              where: { id: attemptId },
              data: { status: AssessmentStatus.CANCELLED }
            }).catch(() => {});
            throw persistErr;
          }
        }

        socket.join(`assessment_${attemptId}`);

        // 3. Stream 20 questions one by one (STRIPPING correctAnswer & explanation).
        // This reveals already-fully-generated questions progressively for UX
        // pacing — it never claims Gemini is generating each one live.
        for (let i = 0; i < questions.length; i++) {
          const rawQ = questions[i];

          const sanitizedQuestion = {
            id: rawQ.id,
            textAr: rawQ.textAr,
            options: rawQ.options.map(opt => ({ id: opt.id, text: opt.text })),
            timeLimitSeconds: rawQ.timeLimitSeconds || 45,
            difficulty: rawQ.assessmentArea || rawQ.difficulty || (i < 5 ? 'التخصص الرئيسي' : (i < 10 ? 'التخصص الفرعي' : (i < 15 ? 'نموذج العمل والتقنيات' : 'مهارات العميل والصفقات')))
          };

          const streamPayload = {
            attemptId,
            questionIndex: i + 1,
            totalQuestions: questions.length,
            question: sanitizedQuestion
          };

          socket.emit('question_streamed', streamPayload);
          if (this.io) {
            this.io.to(`assessment_${attemptId}`).emit('question_streamed', streamPayload);
          }

          // Keep the first question immediate and flow the rest quickly over the socket.
          if (i < questions.length - 1) {
            await new Promise(res => setTimeout(res, 40));
          }
        }

        // 4. Update status to IN_PROGRESS and emit assessment_ready
        try {
          if (attemptId.includes('-') && !attemptId.startsWith('attempt-')) {
            await prisma.assessmentAttempt.update({
              where: { id: attemptId },
              data: { status: AssessmentStatus.IN_PROGRESS }
            });
          }
        } catch (e) {}

        const readyPayload = {
          attemptId,
          totalQuestions: questions.length,
          timeLimitMinutes: 15,
          generationSource,
          message: generationSource === 'GEMINI'
            ? '✓ تم اكتمال بث أسئلة الاختبار الـ 20 بنجاح عبر الذكاء الاصطناعي.'
            : '✓ تعذر توليد أسئلة مخصصة عبر الذكاء الاصطناعي، تم استخدام نموذج تقييم قياسي بديل.'
        };

        socket.emit('assessment_ready', readyPayload);
        if (this.io) {
          this.io.to(`assessment_${attemptId}`).emit('assessment_ready', readyPayload);
        }
      } catch (err: any) {
        console.error('[AssessmentGateway] Start assessment error:', err?.code || err);
        if (claim?.claimed) {
          // Release the reservation on any failure so a retry is never
          // permanently blocked by a stuck STREAMING row (Batch 3D-2). A
          // no-op if the persist-error branch above already released it.
          await prisma.assessmentAttempt.update({
            where: { id: attemptId },
            data: { status: AssessmentStatus.CANCELLED }
          }).catch(() => {});
        }
        socket.emit('assessment_error', { message: 'حدث خطأ أثناء بث أسئلة التقييم الفني عبر الذكاء الاصطناعي.' });
      } finally {
        socket.off('disconnect', onDisconnect);
      }
    });

    /**
     * Event: submit_answer / submit_assessment
     * Evaluates the submitted answers and streams back comprehensive feedback and accreditation status
     */
    socket.on('submit_answer', async (payload: { attemptId: string; answers: Record<string, string> }) => {
      await this.handleSubmission(socket, payload);
    });

    socket.on('submit_assessment', async (payload: { attemptId: string; answers: Record<string, string> }) => {
      await this.handleSubmission(socket, payload);
    });
  }

  private async handleSubmission(socket: Socket, payload: { attemptId: string; answers: Record<string, string> }): Promise<void> {
    const { attemptId, answers } = payload;
    console.log(`[AssessmentGateway] Evaluating submission for attempt ${attemptId}:`, answers);

    const userId = (socket as any).userId as string | undefined;
    if (!userId) {
      socket.emit('assessment_error', { message: 'يجب تسجيل الدخول لتسليم نتائج التقييم.', code: SUBMIT_ERROR_CODES.AUTH_REQUIRED });
      return;
    }

    if (!attemptId) {
      socket.emit('assessment_error', { message: 'معرف محاولة التقييم attemptId مفقود.', code: SUBMIT_ERROR_CODES.INVALID_REQUEST });
      return;
    }

    if (isSocketAiRateLimited(userId)) {
      socket.emit('assessment_error', { message: SOCKET_AI_RATE_LIMIT_MESSAGE, code: SUBMIT_ERROR_CODES.RATE_LIMITED });
      return;
    }

    const abortController = new AbortController();
    const onDisconnect = () => abortController.abort();
    socket.once('disconnect', onDisconnect);

    try {
      let questionsPayload: AssessmentQuestion[] = [];
      let providerSpecialtyId = '';

      // 1. Fetch attempt record from database — filtered by ownership, so a
      // socket can never submit answers for an attempt it doesn't own.
      const isRealDbAttempt = attemptId.includes('-') && !attemptId.startsWith('attempt-');
      if (isRealDbAttempt) {
        const dbAttempt = await prisma.assessmentAttempt.findFirst({
          where: { id: attemptId, providerSpecialty: { providerProfile: { userId } } },
          include: {
            providerSpecialty: {
              include: { specialty: true }
            }
          }
        });

        if (!dbAttempt) {
          socket.emit('assessment_error', { message: 'محاولة التقييم غير موجودة أو لا تملك صلاحية الوصول إليها.', code: SUBMIT_ERROR_CODES.NOT_FOUND });
          return;
        }

        // The attempt may already have been finalized by the REST twin (or a
        // duplicate socket retry) before this handler ran — never re-score
        // or overwrite a terminal outcome (Batch 3D-1).
        if (!SUBMITTABLE_STATUSES.includes(dbAttempt.status)) {
          socket.emit('assessment_error', { message: ALREADY_FINALIZED_MESSAGE, code: SUBMIT_ERROR_CODES.ALREADY_FINALIZED });
          return;
        }

        // Same expiry semantics as the REST twin: 15-minute limit + 1-minute
        // grace period, read from the same attempt row.
        const submissionTime = new Date();
        const elapsedMinutes = (submissionTime.getTime() - new Date(dbAttempt.startedAt).getTime()) / (1000 * 60);
        const isExpired = elapsedMinutes > (dbAttempt.timeLimitMinutes + 1);

        if (isExpired) {
          const expiredClaim = await prisma.assessmentAttempt.updateMany({
            where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES } },
            data: {
              status: AssessmentStatus.EXPIRED,
              completedAt: submissionTime,
              submittedAnswers: answers as any
            }
          });

          if (expiredClaim.count === 0) {
            socket.emit('assessment_error', { message: ALREADY_FINALIZED_MESSAGE, code: SUBMIT_ERROR_CODES.ALREADY_FINALIZED });
            return;
          }

          socket.emit('evaluation_complete', {
            attemptId,
            score: 0,
            scorePercentage: 0,
            correctAnswers: 0,
            totalQuestions: dbAttempt.totalQuestions || 20,
            isPassed: false,
            status: 'EXPIRED',
            feedbackAr: 'انتهت المهلة الزمنية للاختبار (15 دقيقة) قبل تسليم الإجابات.',
            strengths: [],
            weaknesses: ['تجاوز الوقت المخصص للاختبار.'],
            completedAt: submissionTime.toISOString(),
            message: 'انتهت المهلة الزمنية للاختبار (15 دقيقة) قبل تسليم الإجابات.'
          });
          return;
        }

        questionsPayload = (dbAttempt.questionsPayload as unknown as AssessmentQuestion[]) || [];
        providerSpecialtyId = dbAttempt.providerSpecialtyId;
      }

      // If in-memory or DB missing (the attempt was created without a DB
      // record — see the attemptId fallback above), score against the same
      // static bank used elsewhere, honestly.
      if (!questionsPayload || questionsPayload.length === 0) {
        questionsPayload = aiAssessmentAnalyzerService.generateFallback20Questions('التخصص الفني', ['تطوير الأنظمة'], []);
      }

      // 2. Score Calculation
      let correctCount = 0;
      const totalQuestions = questionsPayload.length || 20;

      questionsPayload.forEach(q => {
        const qKey = String(q.id);
        const userChoice = answers[qKey] || answers[q.id as any];
        if (userChoice && q.correctAnswer && userChoice.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase()) {
          correctCount++;
        }
      });

      const scorePercentage = parseFloat(((correctCount / totalQuestions) * 100).toFixed(1));
      const isPassed = scorePercentage > 25.0;

      // Claim the attempt BEFORE calling Gemini (Batch 3D-1): a losing
      // concurrent request (the REST twin, or a duplicate socket retry) must
      // never spend a Gemini call or overwrite the winner's result. Same
      // atomic-updateMany pattern as the expiry branch above; a no-op for the
      // in-memory-fallback case (no DB row exists to protect).
      const completedAt = new Date();
      if (isRealDbAttempt) {
        const claim = await prisma.assessmentAttempt.updateMany({
          where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES } },
          data: {
            submittedAnswers: answers as any,
            score: scorePercentage,
            isPassed,
            status: isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED,
            completedAt
          }
        });

        if (claim.count === 0) {
          socket.emit('assessment_error', { message: ALREADY_FINALIZED_MESSAGE, code: SUBMIT_ERROR_CODES.ALREADY_FINALIZED });
          return;
        }
      }

      // 3. AI Feedback Synthesis via the shared Gemini foundation. Honest
      // failure: the deterministic real-outcome feedback below (already
      // derived from the actual score) is used as-is on any Gemini error.
      let feedbackAr = isPassed
        ? `ممتاز جداً! حققت نتيجة استثنائية بنسبة ${scorePercentage}% وأظهرت كفاءة هندسية عالية وتوافقاً تاماً مع معايير الجودة في المنصة.`
        : `لم تتجاوز الحد الأدنى المطلوب للاجتياز (25%)، نتيجتك: ${scorePercentage}%. يمكنك مراجعة المحاور التقنية وإعادة التقييم.`;

      let strengths: string[] = isPassed
        ? ['فهم متعمق لبنية الأنظمة وأفضل معايير الأمان.', 'قدرة عالية على حل مشاكل الأداء وتأمين الجلسات.', 'استيعاب دقيق لأنماط التصميم والبرمجة النظيفة.']
        : ['مبادرة جيدة واطلاع عام على الأساسيات الفنية.'];

      let weaknesses: string[] = isPassed
        ? []
        : ['الحاجة لتطوير المعرفة العملية في الحالات الحدية لمعالجة الأخطاء.', 'تسرع في اختيار بعض حلول المعاملات المالية المتزامنة.'];

      try {
        const feedbackPrompt = `قم بتحليل نتيجة اختبار 20 سؤالاً:
درجة المتقدم: ${scorePercentage}% (${correctCount}/${totalQuestions})
حالة الاجتياز: ${isPassed ? 'ناجح' : 'لم يجتز'}
الأسئلة والإجابات: ${JSON.stringify(questionsPayload.slice(0, 8).map(q => ({
          question: q.textAr,
          userAnswer: answers[String(q.id)],
          correctAnswer: q.correctAnswer
        })))}`;

        const result = await geminiClient.generateStructured<{ feedbackAr: string; strengths: string[]; weaknesses: string[] }>(feedbackPrompt, {
          systemInstruction: 'أنت المحلل الذكي لتجارب تقييم التخصصات في منصة وسيط AI.',
          responseSchema: FEEDBACK_SCHEMA,
          validate: isValidFeedback,
          temperature: 0.3,
          // Live-Gemini testing found 500 truncated this feedbackAr +
          // strengths[] + weaknesses[] response once gemini-flash-latest's
          // variable reasoning-token overhead is accounted for. Raised with
          // headroom (kept in sync with the REST twin in
          // ai-assessment.service.ts).
          maxOutputTokens: 1000,
          signal: abortController.signal
        });

        feedbackAr = result.data.feedbackAr;
        strengths = result.data.strengths;
        weaknesses = result.data.weaknesses;
      } catch (aiErr: any) {
        console.warn('[AssessmentGateway] Gemini feedback synthesis unavailable, using deterministic real-outcome feedback:', aiErr?.code || aiErr?.message);
      }

      // 4. Persist feedback + ProviderSpecialty outcome. The claim above
      // already won this attempt exclusively (score/status/completedAt are
      // already committed), so this transaction only adds the feedback text
      // and the downstream ProviderSpecialty effect.
      if (isRealDbAttempt) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.assessmentAttempt.update({
              where: { id: attemptId },
              data: { feedbackAr, strengths, weaknesses }
            });

            if (providerSpecialtyId) {
              await tx.providerSpecialty.update({
                where: { id: providerSpecialtyId },
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
            }
          });
        } catch (dbUpdateErr) {
          console.error('[AssessmentGateway] DB completion update error:', dbUpdateErr);
        }
      }

      // 5. Emit evaluation_complete event
      const resultPayload = {
        attemptId,
        score: scorePercentage,
        scorePercentage,
        correctAnswers: correctCount,
        totalQuestions,
        isPassed,
        status: isPassed ? 'APPROVED' : 'FAILED',
        feedbackAr,
        strengths,
        weaknesses,
        completedAt: completedAt.toISOString(),
        message: isPassed
          ? '🎉 مبروك! اجتزت التقييم بنجاح وتم منحك شارة اعتماد الجدارة المهنية!'
          : 'لم تتجاوز الحد الأدنى المطلوب للاجتياز (25%). يمكنك المحاولة مجدداً لاحقاً.'
      };

      socket.emit('evaluation_complete', resultPayload);
      if (this.io) {
        this.io.to(`assessment_${attemptId}`).emit('evaluation_complete', resultPayload);
      }
    } catch (err: any) {
      console.error('[AssessmentGateway] Evaluation submission error:', err);
      socket.emit('assessment_error', { message: 'فشل معالجة التقييم النهائي عبر الـ WebSocket.', code: SUBMIT_ERROR_CODES.SUBMISSION_FAILED });
    } finally {
      socket.off('disconnect', onDisconnect);
    }
  }
}

export const assessmentGateway = new AssessmentGateway();
export const registerAssessmentGateway = (socket: Socket, io?: SocketIOServer) => assessmentGateway.register(socket, io);
