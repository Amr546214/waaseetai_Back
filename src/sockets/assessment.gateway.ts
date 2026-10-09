import { Socket, Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/db';
import {
  ASSESSMENT_GENERATION_FAILED_CODE,
  ASSESSMENT_GENERATION_FAILED_MESSAGE,
  ASSESSMENT_GRADING_FAILED_CODE,
  ASSESSMENT_TIME_LIMIT_MINUTES,
  EXPIRED_FEEDBACK_AR,
  EXPIRED_WEAKNESS_AR,
  claimAssessmentGeneration,
  processAssessmentSubmission,
  recordAssessmentAnswer,
  sanitizeQuestions,
  streamAssessmentForClaim,
  assessmentResultMessage,
  PublicAssessmentQuestion
} from '../services/ai-assessment.service';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// Live assessment socket flow. All question generation and grading runs
// through the external WaseetAI service (see ai-assessment.service.ts);
// this gateway owns only transport concerns: authentication, ownership,
// rate limiting, relaying events to the UI's existing socket contract and
// mapping submission outcomes to structured error codes. Timing (expiry),
// the generation claim and the atomic submission claim live in the service,
// shared with the REST twin, so the two transports can never double-process.

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

export class AssessmentGateway {
  private io: SocketIOServer | null = null;

  public register(socket: Socket, io?: SocketIOServer): void {
    if (io) this.io = io;

    /**
     * Event: start_assessment
     * Generates the assessment through WaseetAI's streaming endpoint and
     * relays each question to the client as soon as it arrives.
     */
    socket.on('start_assessment', async (payload: { providerSpecialtyId?: string }) => {
      const userId = (socket as any).userId as string | undefined;
      const providerSpecId = payload?.providerSpecialtyId;
      if (!userId || !providerSpecId) {
        socket.emit('assessment_error', { message: 'بيانات المصادقة والتخصص مطلوبة.' });
        return;
      }

      if (isSocketAiRateLimited(userId)) {
        socket.emit('assessment_error', { message: SOCKET_AI_RATE_LIMIT_MESSAGE });
        return;
      }

      // Ownership check; the specialty name sent to WaseetAI comes from our
      // DB, never from the client payload.
      const providerSpecialty = await prisma.providerSpecialty.findFirst({
        where: { id: providerSpecId, providerProfile: { userId } },
        select: { id: true, specialtyId: true, providerProfileId: true, specialty: { select: { nameAr: true, name: true } } }
      });
      if (!providerSpecialty) {
        socket.emit('assessment_error', { message: 'التخصص غير موجود أو لا تملك صلاحية الوصول إليه.' });
        return;
      }
      const specialtyName = providerSpecialty.specialty?.nameAr || providerSpecialty.specialty?.name || 'التخصص الفني';

      // Claim generation BEFORE calling WaseetAI. A claim failure is an
      // error: without the reserved row there is nowhere to keep the key-less
      // questions and the WaseetAI attempt id needed for grading.
      let claim;
      try {
        claim = await claimAssessmentGeneration(providerSpecId, providerSpecialty.providerProfileId, providerSpecialty.specialtyId);
      } catch (claimErr) {
        const e: any = claimErr;
        if (e && typeof e.statusCode === 'number' && e.statusCode < 500 && e.code) {
          // coded business refusal (not eligible / cooldown / attempt limit / not found): same rules and wording as the REST twin
          socket.emit('assessment_error', { message: e.message, code: e.code, ...(typeof e.retryAfterSeconds === 'number' ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
          return;
        }
        console.error('[AssessmentGateway] Generation claim failed:', claimErr);
        socket.emit('assessment_error', { message: ASSESSMENT_GENERATION_FAILED_MESSAGE, code: ASSESSMENT_GENERATION_FAILED_CODE });
        return;
      }

      if (!claim.claimed) {
        const existingQuestions = sanitizeQuestions((Array.isArray(claim.existingQuestionsPayload) ? claim.existingQuestionsPayload : []) as any[]);
        if (existingQuestions.length === 0) {
          // Generation is genuinely in flight elsewhere — nothing to replay yet.
          socket.emit('assessment_error', { message: GENERATION_IN_PROGRESS_MESSAGE });
          return;
        }

        // Generation already finished elsewhere — replay the stored questions.
        existingQuestions.forEach((q, i) => {
          socket.emit('question_streamed', this.questionEvent(claim.attemptId, q, i + 1, existingQuestions.length));
        });
        socket.emit('assessment_ready', {
          attemptId: claim.attemptId,
          totalQuestions: existingQuestions.length,
          timeLimitMinutes: ASSESSMENT_TIME_LIMIT_MINUTES,
          ...(claim.existingGenerationSource ? { generationSource: claim.existingGenerationSource } : {}),
          message: '✓ تم تجهيز أسئلة الاختبار.'
        });
        return;
      }

      const attemptId = claim.attemptId;
      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);
      socket.join(`assessment_${attemptId}`);

      try {
        // Each question is relayed the moment WaseetAI emits it. The service
        // persists the key-less payload + WaseetAI attempt id, releasing the
        // reservation itself on any failure.
        const generated = await streamAssessmentForClaim({
          claimAttemptId: attemptId,
          providerSpecialtyId: providerSpecId,
          specialtyName,
          signal: abortController.signal,
          onQuestion: (question, index, total) => {
            const streamPayload = this.questionEvent(attemptId, question, index, total);
            socket.emit('question_streamed', streamPayload);
            if (this.io) this.io.to(`assessment_${attemptId}`).emit('question_streamed', streamPayload);
          }
        });

        const readyPayload = {
          attemptId,
          totalQuestions: generated.totalQuestions,
          timeLimitMinutes: generated.timeLimitMinutes,
          // Relayed as reported by WaseetAI; omitted when it reports none.
          ...(generated.generationSource ? { generationSource: generated.generationSource } : {}),
          message: '✓ تم اكتمال بث أسئلة الاختبار.'
        };
        socket.emit('assessment_ready', readyPayload);
        if (this.io) this.io.to(`assessment_${attemptId}`).emit('assessment_ready', readyPayload);
      } catch (err: any) {
        console.error('[AssessmentGateway] Start assessment error:', err?.code || err);
        socket.emit('assessment_error', { message: ASSESSMENT_GENERATION_FAILED_MESSAGE, code: ASSESSMENT_GENERATION_FAILED_CODE });
      } finally {
        socket.off('disconnect', onDisconnect);
      }
    });

    /**
     * Event: submit_answer / submit_assessment
     * Evaluates the submitted answers and streams back comprehensive feedback and accreditation status
     */
    /**
     * Event: record_answer { attemptId, questionId, answer } — the client reports each choice as it is made so the server can time it
     * (review flags only; the final answers still arrive through submit_answer / submit_assessment). Silent: never emits an error.
     */
    socket.on('record_answer', async (payload: { attemptId?: string; questionId?: string | number; answer?: string }) => {
      const userId = (socket as any).userId as string | undefined;
      if (!userId || !payload?.attemptId || payload.questionId === undefined) return;
      try { await recordAssessmentAnswer(userId, String(payload.attemptId), String(payload.questionId), String(payload.answer ?? '')); } catch { /* best effort */ }
    });

    socket.on('submit_answer', async (payload: { attemptId: string; answers: Record<string, string> }) => {
      await this.handleSubmission(socket, payload);
    });

    socket.on('submit_assessment', async (payload: { attemptId: string; answers: Record<string, string> }) => {
      await this.handleSubmission(socket, payload);
    });
  }

  private questionEvent(attemptId: string, question: PublicAssessmentQuestion, questionIndex: number, totalQuestions: number) {
    return {
      attemptId,
      questionIndex,
      totalQuestions,
      question: {
        id: question.id,
        textAr: question.textAr,
        options: question.options.map((opt) => ({ id: opt.id, text: opt.text })),
        // Only set for legacy attempts; WaseetAI sends no per-question label.
        ...(question.assessmentArea ? { difficulty: question.assessmentArea } : {})
      }
    };
  }

  private async handleSubmission(socket: Socket, payload: { attemptId: string; answers: Record<string, string> }): Promise<void> {
    const { attemptId, answers } = payload || ({} as { attemptId: string; answers: Record<string, string> });

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

    try {
      // Ownership, status, expiry, atomic claim, WaseetAI grading and
      // persistence are all handled by the shared service.
      const outcome = await processAssessmentSubmission(attemptId, userId, answers);

      if (outcome.kind === 'NOT_FOUND') {
        socket.emit('assessment_error', { message: 'محاولة التقييم غير موجودة أو لا تملك صلاحية الوصول إليها.', code: SUBMIT_ERROR_CODES.NOT_FOUND });
        return;
      }
      if (outcome.kind === 'ALREADY_FINALIZED') {
        socket.emit('assessment_error', { message: ALREADY_FINALIZED_MESSAGE, code: SUBMIT_ERROR_CODES.ALREADY_FINALIZED });
        return;
      }

      if (outcome.kind === 'EXPIRED') {
        socket.emit('evaluation_complete', {
          attemptId,
          score: 0,
          scorePercentage: 0,
          correctAnswers: 0,
          totalQuestions: outcome.totalQuestions,
          isPassed: false,
          status: 'EXPIRED',
          feedbackAr: EXPIRED_FEEDBACK_AR,
          strengths: [],
          weaknesses: [EXPIRED_WEAKNESS_AR],
          completedAt: outcome.completedAt.toISOString(),
          message: EXPIRED_FEEDBACK_AR
        });
        return;
      }

      const { result } = outcome;
      const resultPayload = {
        attemptId,
        score: result.score,
        scorePercentage: result.score,
        // Known only for legacy local grading; WaseetAI returns no count.
        ...(outcome.correctCount !== undefined ? { correctAnswers: outcome.correctCount } : {}),
        totalQuestions: outcome.totalQuestions,
        isPassed: result.isPassed,
        // the ATTEMPT's status; the specialty's real state is reported separately (a pass is never announced as an approval)
        status: result.isPassed ? 'PASSED' : 'FAILED',
        specialtyStatus: result.specialtyStatus,
        specialtyApproved: result.specialtyApproved === true,
        awaitingAdminApproval: result.awaitingAdminApproval === true,
        feedbackAr: result.feedbackAr,
        strengths: result.strengths,
        weaknesses: result.weaknesses,
        completedAt: result.completedAt.toISOString(),
        message: assessmentResultMessage(result)
      };

      socket.emit('evaluation_complete', resultPayload);
      if (this.io) {
        this.io.to(`assessment_${attemptId}`).emit('evaluation_complete', resultPayload);
      }
    } catch (err: any) {
      // Grading failures (claim already released, nothing scored) and any
      // unexpected processing error are retryable by the client.
      console.error('[AssessmentGateway] Evaluation submission error:', err?.code === ASSESSMENT_GRADING_FAILED_CODE ? err.code : err);
      socket.emit('assessment_error', { message: 'فشل معالجة التقييم النهائي عبر الـ WebSocket.', code: SUBMIT_ERROR_CODES.SUBMISSION_FAILED });
    }
  }
}

export const assessmentGateway = new AssessmentGateway();
export const registerAssessmentGateway = (socket: Socket, io?: SocketIOServer) => assessmentGateway.register(socket, io);
