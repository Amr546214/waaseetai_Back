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

      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);

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

        // 2. Create AssessmentAttempt in database with status STREAMING
        let attemptId = `attempt-${Date.now()}`;
        try {
          const attemptRecord = await prisma.assessmentAttempt.create({
            data: {
              providerSpecialtyId: providerSpecId,
              providerProfileId: profileId,
              specialtyId: specId,
              subSpecialtiesSnapshot: subSpecialtiesSnapshot as any,
              analyzedAssetsSnapshot: { items: analyzedAssetsSnapshot, generationSource } as any,
              questionsPayload: questions as any,
              totalQuestions: 20,
              status: AssessmentStatus.STREAMING,
              timeLimitMinutes: 15,
              startedAt: new Date()
            }
          });
          attemptId = attemptRecord.id;
        } catch (dbErr) {
          console.warn('[AssessmentGateway] DB record creation fallback to in-memory attemptId:', dbErr);
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
      socket.emit('assessment_error', { message: 'يجب تسجيل الدخول لتسليم نتائج التقييم.' });
      return;
    }

    if (!attemptId) {
      socket.emit('assessment_error', { message: 'معرف محاولة التقييم attemptId مفقود.' });
      return;
    }

    if (isSocketAiRateLimited(userId)) {
      socket.emit('assessment_error', { message: SOCKET_AI_RATE_LIMIT_MESSAGE });
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
          socket.emit('assessment_error', { message: 'محاولة التقييم غير موجودة أو لا تملك صلاحية الوصول إليها.' });
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

      // 4. Update Database Transactionally
      const completedAt = new Date();
      if (isRealDbAttempt) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.assessmentAttempt.update({
              where: { id: attemptId },
              data: {
                submittedAnswers: answers as any,
                score: scorePercentage,
                isPassed,
                feedbackAr,
                strengths,
                weaknesses,
                status: isPassed ? AssessmentStatus.COMPLETED : AssessmentStatus.FAILED,
                completedAt
              }
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
      socket.emit('assessment_error', { message: 'فشل معالجة التقييم النهائي عبر الـ WebSocket.' });
    } finally {
      socket.off('disconnect', onDisconnect);
    }
  }
}

export const assessmentGateway = new AssessmentGateway();
export const registerAssessmentGateway = (socket: Socket, io?: SocketIOServer) => assessmentGateway.register(socket, io);
