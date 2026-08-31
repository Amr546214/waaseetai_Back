import { Socket, Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/db';
import { SpecialtyVerificationStatus, TestSessionStatus } from '@prisma/client';
import { DynamicQuizPayload } from '../prompts/quiz.prompt';
import { notifyAndEmailQuizResult } from '../controllers/quiz.controller';

const VIOLATION_LOCKOUT_THRESHOLD = 3; // Maximum allowable anti-cheat infractions before automatic invalidation
const PASS_THRESHOLD_PERCENT = 25.0;

// Memory registry to keep track of live session timers to prevent duplicates and enable clean shutdown
const sessionTimers = new Map<string, NodeJS.Timeout>();

export class QuizSocketGateway {
  private io: SocketIOServer | null = null;

  public register(socket: Socket, io?: SocketIOServer): void {
    if (io) this.io = io;

    /**
     * Event: quiz:start
     * Client initiates synchronized live test monitoring and timer broadcasts
     */
    socket.on('quiz:start', async (payload: { sessionId: string; providerSpecialtyId: string; requestStream?: boolean }) => {
      const { sessionId, providerSpecialtyId, requestStream } = payload;
      if (!sessionId) {
        socket.emit('quiz:error', { message: 'معرف الجلسة sessionId مطلوب لبدء المراقبة الحية.' });
        return;
      }

      console.log(`[Quiz Socket] Client ${socket.id} started quiz monitoring for session ${sessionId}`);
      socket.join(`quiz_${sessionId}`);
      socket.join(`specialty_${providerSpecialtyId}`);

      try {
        const session = await prisma.specialtyTestSession.findUnique({
          where: { id: sessionId },
          include: { providerSpecialty: true }
        });

        if (!session || session.status !== TestSessionStatus.IN_PROGRESS) {
          socket.emit('quiz:error', { message: 'جلسة الاختبار غير صالحة أو غير نشطة.' });
          return;
        }

        const expiresAtMs = new Date(session.expiresAt).getTime();
        const initialRemainingSec = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));

        socket.emit('quiz:timer_sync', {
          sessionId,
          remainingSec: initialRemainingSec,
          expiresAt: session.expiresAt,
          violationCount: session.antiCheatViolations,
          status: session.status
        });

        // If client requested progressive question streaming ("like typing"), trigger stream
        if (requestStream) {
          this.streamQuestionsToClient(socket, sessionId, session.questionsPayload as any);
        }

        // Initialize synchronized server timer if not already ticking for this session
        if (!sessionTimers.has(sessionId)) {
          const timer = setInterval(async () => {
            const nowMs = Date.now();
            const remainingSec = Math.floor((expiresAtMs - nowMs) / 1000);

            if (remainingSec <= 0) {
              console.log(`[Quiz Socket Timer] Session ${sessionId} expired. Triggering automatic timeout evaluation.`);
              this.stopTimer(sessionId);
              await this.executeTimeoutEvaluation(sessionId);
            } else {
              if (this.io) {
                this.io.to(`quiz_${sessionId}`).emit('quiz:timer_tick', {
                  sessionId,
                  remainingSec,
                  timestamp: nowMs
                });
              } else {
                socket.emit('quiz:timer_tick', { sessionId, remainingSec, timestamp: nowMs });
              }
            }
          }, 1000);

          sessionTimers.set(sessionId, timer);
        }
      } catch (err: any) {
        console.error('[Quiz Socket Start Error]:', err);
        socket.emit('quiz:error', { message: 'فشل تهيئة ساعة التزامن الحية في السيرفر.' });
      }
    });

    /**
     * Event: quiz:request_stream
     * Explicit request to stream the 20 technical questions one-by-one with a typing effect
     */
    socket.on('quiz:request_stream', async (payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      try {
        const session = await prisma.specialtyTestSession.findUnique({
          where: { id: payload.sessionId }
        });
        if (!session || session.status !== TestSessionStatus.IN_PROGRESS) return;
        this.streamQuestionsToClient(socket, payload.sessionId, session.questionsPayload as any);
      } catch (err) {
        console.error('[Quiz Stream Error]:', err);
      }
    });

    /**
     * Event: quiz:anti_cheat_violation
     * Strict Web Anti-Cheat lockdown handler (browser blur, visibility change, tab switch, navigation attempt)
     */
    socket.on('quiz:anti_cheat_violation', async (payload: { sessionId: string; violationType: string; timestamp?: number }) => {
      const { sessionId, violationType } = payload;
      if (!sessionId) return;

      console.warn(`[Quiz Anti-Cheat Violation] Socket ${socket.id}, Session ${sessionId}, Type: ${violationType || 'WEB_BLUR'}`);

      try {
        const session = await prisma.specialtyTestSession.findUnique({
          where: { id: sessionId },
          include: { providerSpecialty: true }
        });

        if (!session || session.status !== TestSessionStatus.IN_PROGRESS) return;

        const currentEvents: any[] = Array.isArray(session.violationEvents) ? (session.violationEvents as any[]) : [];
        const newViolationEvent = {
          type: violationType || 'TAB_SWITCH_OR_BLUR',
          timestamp: payload.timestamp || Date.now(),
          socketId: socket.id
        };

        const updatedViolationsCount = session.antiCheatViolations + 1;
        currentEvents.push(newViolationEvent);

        // If threshold reached or exceeded, invalidate session immediately via transaction and impose 24h lockout
        if (updatedViolationsCount >= VIOLATION_LOCKOUT_THRESHOLD) {
          console.error(`[Quiz Anti-Cheat Lockdown] Session ${sessionId} reached ${updatedViolationsCount} infractions! Invalidating.`);
          this.stopTimer(sessionId);

          const lockoutDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

          await prisma.$transaction([
            prisma.specialtyTestSession.update({
              where: { id: sessionId },
              data: {
                status: TestSessionStatus.INVALIDATED,
                antiCheatViolations: updatedViolationsCount,
                violationEvents: currentEvents as any,
                completedAt: new Date()
              }
            }),
            prisma.providerSpecialty.update({
              where: { id: session.providerSpecialtyId },
              data: {
                status: SpecialtyVerificationStatus.LOCKED_OUT,
                lockoutUntil: lockoutDate
              }
            })
          ]);

          const lockoutPayload = {
            sessionId,
            invalidated: true,
            reason: 'ANTI_CHEAT_LOCKDOWN',
            violationCount: updatedViolationsCount,
            lockoutUntil: lockoutDate,
            message: '🚨 تم إبطال الاختبار وقفل التخصص لمدة 24 ساعة بسبب اكتشاف محاولات تكرارية لمغادرة شاشة الاختبار ومخالفة نظام مراقبة الغش.'
          };

          if (this.io) {
            this.io.to(`quiz_${sessionId}`).emit('quiz:anti_cheat_lockdown', lockoutPayload);
          } else {
            socket.emit('quiz:anti_cheat_lockdown', lockoutPayload);
          }

          // Trigger automated result email via Nodemailer & app notification for lockdown event
          notifyAndEmailQuizResult(sessionId).catch(err => console.error('[Quiz Anti-Cheat Notify Error]:', err));
        } else {
          await prisma.specialtyTestSession.update({
            where: { id: sessionId },
            data: {
              antiCheatViolations: updatedViolationsCount,
              violationEvents: currentEvents as any
            }
          });

          const warningPayload = {
            sessionId,
            violationCount: updatedViolationsCount,
            maxAllowed: VIOLATION_LOCKOUT_THRESHOLD,
            violationType,
            message: `⚠️ تنبيه حازم من نظام مكافحة الغش: رصد مغادرة أو إلغاء تركيز المتصفح (${updatedViolationsCount} / ${VIOLATION_LOCKOUT_THRESHOLD}). المحاولة الثالثة ستؤدي إلى إلغاء الاختبار وحظر دخولك لمدة 24 ساعة.`
          };

          if (this.io) {
            this.io.to(`quiz_${sessionId}`).emit('quiz:anti_cheat_warning', warningPayload);
          } else {
            socket.emit('quiz:anti_cheat_warning', warningPayload);
          }
        }
      } catch (err: any) {
        console.error('[Quiz Anti-Cheat Processing Error]:', err);
      }
    });

    /**
     * Event: quiz:submit_answers
     * Atomic real-time submission and evaluation algorithm
     */
    socket.on('quiz:submit_answers', async (payload: { sessionId: string; answers: Array<{ questionId: string; selectedIndex: number; timeTakenSec?: number }> }) => {
      const { sessionId, answers } = payload;
      if (!sessionId) {
        socket.emit('quiz:error', { message: 'معرف الجلسة sessionId مفقود في إيراد البيانات.' });
        return;
      }

      console.log(`[Quiz Socket Submit] Processing real-time evaluation for session ${sessionId}`);
      this.stopTimer(sessionId);

      try {
        const session = await prisma.specialtyTestSession.findUnique({
          where: { id: sessionId },
          include: { providerSpecialty: true }
        });

        if (!session || session.status !== TestSessionStatus.IN_PROGRESS) {
          socket.emit('quiz:error', { message: 'الجلسة غير صالحة للتقديم أو تم إغلاقها مسبقاً.' });
          return;
        }

        const quizData = session.questionsPayload as unknown as DynamicQuizPayload;
        const allQuestions = quizData.questions || [];
        const userAnswers = Array.isArray(answers) ? answers : [];

        let correctCount = 0;
        const submissionsCreateData = allQuestions.map(q => {
          const uAns = userAnswers.find(a => a.questionId === q.id);
          const selectedIndex = uAns !== undefined ? Number(uAns.selectedIndex) : -1;
          const isCorrect = selectedIndex === q.correctOptionIndex;
          if (isCorrect) correctCount++;

          return {
            questionId: q.id,
            subSpecialtyTag: q.subSpecialtyTag || 'عام',
            selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
            isCorrect,
            timeTakenSec: uAns?.timeTakenSec || 0
          };
        });

        const totalQuestions = allQuestions.length || 20;
        const scorePercentage = parseFloat(((correctCount / totalQuestions) * 100).toFixed(1));
        const passed = scorePercentage > PASS_THRESHOLD_PERCENT;

        // Atomic database write via transaction
        const [updatedSession, updatedSpecialty] = await prisma.$transaction(async (tx) => {
          const sess = await tx.specialtyTestSession.update({
            where: { id: sessionId },
            data: {
              status: TestSessionStatus.COMPLETED,
              correctAnswers: correctCount,
              scorePercentage,
              passed,
              completedAt: new Date(),
              submissions: { create: submissionsCreateData }
            },
            include: { submissions: true }
          });

          let specStatus = passed ? SpecialtyVerificationStatus.APPROVED : SpecialtyVerificationStatus.REJECTED;
          const updateData: any = {
            quizScore: scorePercentage,
            status: specStatus,
          };

          if (passed) {
            updateData.badgeGrantedAt = new Date();
            updateData.lockoutUntil = null;
          } else {
            updateData.status = SpecialtyVerificationStatus.LOCKED_OUT;
            updateData.lockoutUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
          }

          const spec = await tx.providerSpecialty.update({
            where: { id: session.providerSpecialtyId },
            data: updateData
          });

          return [sess, spec];
        });

        const detailedResults = allQuestions.map(q => {
          const uAns = userAnswers.find(a => a.questionId === q.id);
          return {
            questionId: q.id,
            text: q.text,
            subSpecialtyTag: q.subSpecialtyTag,
            options: q.options,
            selectedIndex: uAns !== undefined ? uAns.selectedIndex : -1,
            correctOptionIndex: q.correctOptionIndex,
            isCorrect: (uAns?.selectedIndex === q.correctOptionIndex),
            explanation: q.explanation
          };
        });

        const resultPayload = {
          sessionId,
          passed,
          scorePercentage,
          correctAnswers: correctCount,
          totalQuestions,
          status: updatedSpecialty.status,
          badgeGrantedAt: updatedSpecialty.badgeGrantedAt,
          lockoutUntil: updatedSpecialty.lockoutUntil,
          detailedResults,
          message: passed
            ? '✓ مبروك! اجتزت اختبار اعتماد التخصص بنجاح وتم تفعيل شارة الاعتماد!'
            : 'لم تتجاوز نسبة النجاح المشروطة (25%). تم قفل إعادة الاختبار لمدة 24 ساعة.'
        };

        if (this.io) {
          this.io.to(`quiz_${sessionId}`).emit('quiz:result', resultPayload);
        } else {
          socket.emit('quiz:result', resultPayload);
        }

        // Trigger automated result email via Nodemailer & in-app notification
        notifyAndEmailQuizResult(sessionId).catch(err => console.error('[Quiz Socket Submit Notify Error]:', err));
      } catch (err: any) {
        console.error('[Quiz Socket Submission Error]:', err);
        socket.emit('quiz:error', { message: 'فشل معالجة تقييم الاختبار عبر الـ WebSocket.' });
      }
    });

    /**
     * Event: quiz:timeout
     * Force timeout evaluation when time expires
     */
    socket.on('quiz:timeout', async (payload: { sessionId: string }) => {
      if (!payload.sessionId) return;
      this.stopTimer(payload.sessionId);
      await this.executeTimeoutEvaluation(payload.sessionId);
    });

    socket.on('disconnect', () => {
      // Clean up socket resources; timers continue ticking independently for active sessions
    });
  }

  private async streamQuestionsToClient(socket: Socket, sessionId: string, payload: any): Promise<void> {
    const quizData = payload as DynamicQuizPayload;
    const questions = (quizData?.questions || []).map(q => ({
      id: q.id,
      subSpecialtyTag: q.subSpecialtyTag,
      text: q.text,
      options: q.options
    }));

    console.log(`[Quiz Socket Stream] Streaming ${questions.length} questions one-by-one to client ${socket.id}`);
    for (let i = 0; i < questions.length; i++) {
      socket.emit('quiz:stream_question', {
        sessionId,
        question: questions[i],
        index: i,
        total: questions.length,
        isLast: i === questions.length - 1
      });
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }

  private stopTimer(sessionId: string): void {
    const timer = sessionTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      sessionTimers.delete(sessionId);
    }
  }

  /**
   * Executes automatic evaluation upon timeout, marking un-submitted questions as incorrect
   * and updating ProviderSpecialty status atomically.
   */
  private async executeTimeoutEvaluation(sessionId: string): Promise<void> {
    try {
      const session = await prisma.specialtyTestSession.findUnique({
        where: { id: sessionId },
        include: { providerSpecialty: true }
      });

      if (!session || session.status !== TestSessionStatus.IN_PROGRESS) return;

      const quizData = session.questionsPayload as unknown as DynamicQuizPayload;
      const allQuestions = quizData?.questions || [];
      const totalQuestions = allQuestions.length || 20;

      const correctCount = 0;
      const scorePercentage = 0.0;
      const passed = false;

      const lockoutDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const [updatedSession, updatedSpecialty] = await prisma.$transaction([
        prisma.specialtyTestSession.update({
          where: { id: sessionId },
          data: {
            status: TestSessionStatus.TIMED_OUT,
            correctAnswers: correctCount,
            scorePercentage,
            passed,
            completedAt: new Date()
          }
        }),
        prisma.providerSpecialty.update({
          where: { id: session.providerSpecialtyId },
          data: {
            status: SpecialtyVerificationStatus.LOCKED_OUT,
            quizScore: scorePercentage,
            lockoutUntil: lockoutDate
          }
        })
      ]);

      const timeoutResult = {
        sessionId,
        passed: false,
        scorePercentage: 0.0,
        correctAnswers: 0,
        totalQuestions,
        isTimedOut: true,
        status: updatedSpecialty.status,
        lockoutUntil: lockoutDate,
        message: '⏱️ انتهت المهلة الزمنية المخصصة للاختبار (30 دقيقة). تم إقفال الجلسة وتطبيق حظر الإعادة لمدة 24 ساعة.'
      };

      if (this.io) {
        this.io.to(`quiz_${sessionId}`).emit('quiz:result_timeout', timeoutResult);
      }

      // Trigger automated result email via Nodemailer & in-app notification upon timeout
      notifyAndEmailQuizResult(sessionId).catch(err => console.error('[Quiz Timeout Notify Error]:', err));
    } catch (error) {
      console.error('[Quiz Timeout Evaluation Error]:', error);
    }
  }
}

export const quizSocketGateway = new QuizSocketGateway();
export const registerQuizSocketGateway = (socket: Socket, io?: SocketIOServer) => quizSocketGateway.register(socket, io);
