import { Socket, Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/db';
import { AssessmentStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { aiAssessmentAnalyzerService, AssessmentQuestion } from '../services/ai-assessment-analyzer.service';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key_for_build',
  timeout: 45 * 1000,
});

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

      const specId = payload.specialtyId || 'demo-specialty-id';
      const providerSpecId = payload.providerSpecialtyId || 'demo-provider-spec-id';
      let profileId = payload.providerProfileId;

      // Try resolving providerProfileId if missing
      if (!profileId && providerSpecId && providerSpecId !== 'demo-provider-spec-id') {
        const ps = await prisma.providerSpecialty.findUnique({
          where: { id: providerSpecId },
          select: { providerProfileId: true }
        });
        if (ps) profileId = ps.providerProfileId;
      }

      if (!profileId) {
        const firstProfile = await prisma.providerProfile.findFirst();
        profileId = firstProfile?.id || 'demo-profile-uuid';
      }

      try {
        // 1. Analyze specialty, sub-specialties, and portfolio files to generate 20 questions
        const { questions, subSpecialtiesSnapshot, analyzedAssetsSnapshot } = 
          await aiAssessmentAnalyzerService.generate20Questions({
            providerSpecialtyId: providerSpecId,
            specialtyId: specId,
            subSpecialties: payload.subSpecialtyIds,
            portfolioFileUrls: payload.portfolioFileUrls,
            categoryName: payload.categoryName,
            specialtyName: payload.specialtyName,
            providerProfileId: profileId
          });

        // 2. Create AssessmentAttempt in database with status STREAMING
        let attemptId = `attempt-${Date.now()}`;
        try {
          if (providerSpecId !== 'demo-provider-spec-id' && profileId !== 'demo-profile-uuid') {
            const attemptRecord = await prisma.assessmentAttempt.create({
              data: {
                providerSpecialtyId: providerSpecId,
                providerProfileId: profileId,
                specialtyId: specId,
                subSpecialtiesSnapshot: subSpecialtiesSnapshot as any,
                analyzedAssetsSnapshot: analyzedAssetsSnapshot as any,
                questionsPayload: questions as any,
                totalQuestions: 20,
                status: AssessmentStatus.STREAMING,
                timeLimitMinutes: 15,
                startedAt: new Date()
              }
            });
            attemptId = attemptRecord.id;
          }
        } catch (dbErr) {
          console.warn('[AssessmentGateway] DB record creation fallback to in-memory attemptId:', dbErr);
        }

        socket.join(`assessment_${attemptId}`);

        // 3. Stream 20 questions one by one (STRIPPING correctAnswer & explanation)
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
          message: '✓ تم اكتمال بث أسئلة الاختبار الـ 20 بنجاح عبر محرك الذكاء الاصطناعي.'
        };

        socket.emit('assessment_ready', readyPayload);
        if (this.io) {
          this.io.to(`assessment_${attemptId}`).emit('assessment_ready', readyPayload);
        }
      } catch (err: any) {
        console.error('[AssessmentGateway] Start assessment error:', err);
        socket.emit('assessment_error', { message: 'حدث خطأ أثناء بث أسئلة التقييم الفني عبر الذكاء الاصطناعي.' });
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

    if (!attemptId) {
      socket.emit('assessment_error', { message: 'معرف محاولة التقييم attemptId مفقود.' });
      return;
    }

    try {
      let questionsPayload: AssessmentQuestion[] = [];
      let providerSpecialtyId = '';
      let providerProfileId = '';

      // 1. Fetch attempt record from database
      if (attemptId.includes('-') && !attemptId.startsWith('attempt-')) {
        const dbAttempt = await prisma.assessmentAttempt.findUnique({
          where: { id: attemptId },
          include: {
            providerSpecialty: {
              include: { specialty: true }
            }
          }
        });

        if (dbAttempt) {
          questionsPayload = (dbAttempt.questionsPayload as unknown as AssessmentQuestion[]) || [];
          providerSpecialtyId = dbAttempt.providerSpecialtyId;
          providerProfileId = dbAttempt.providerProfileId;
        }
      }

      // If in-memory or DB missing, generate standard fallback key
      if (!questionsPayload || questionsPayload.length === 0) {
        questionsPayload = aiAssessmentAnalyzerService['generateFallback20Questions']('التخصص الفني', ['تطوير الأنظمة'], []);
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

      // 3. AI Feedback Synthesis via GPT-4o
      let feedbackAr = isPassed
        ? `ممتاز جداً! حققت نتيجة استثنائية بنسبة ${scorePercentage}% وأظهرت كفاءة هندسية عالية وتوافقاً تاماً مع معايير الجودة في المنصة.`
        : `لم تتجاوز الحد الأدنى المطلوب للاجتياز (25%)، نتيجتك: ${scorePercentage}%. يمكنك مراجعة المحاور التقنية وإعادة التقييم.`;
      
      let strengths: string[] = isPassed
        ? ['فهم متعمق لبنية الأنظمة وأفضل معايير الأمان.', 'قدرة عالية على حل مشاكل الأداء وتأمين الجلسات.', 'استيعاب دقيق لأنماط التصميم والبرمجة النظيفة.']
        : ['مبادرة جيدة واطلاع عام على الأساسيات الفنية.'];
      
      let weaknesses: string[] = isPassed
        ? []
        : ['الحاجة لتطوير المعرفة العملية في الحالات الحدية لمعالجة الأخطاء.', 'تسرع في اختيار بعض حلول المعاملات المالية المتزامنة.'];

      if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key_for_build') {
        try {
          const aiRes = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'أنت المحلل الذكي لتجارب تقييم التخصصات في منصة وسيط AI.' },
              {
                role: 'user',
                content: `قم بتحليل نتيجة اختبار 20 سؤالاً:
درجة المتقدم: ${scorePercentage}% (${correctCount}/${totalQuestions})
حالة الاجتياز: ${isPassed ? 'ناجح' : 'لم يجتز'}
الأسئلة والإجابات: ${JSON.stringify(questionsPayload.slice(0, 8).map(q => ({
                  question: q.textAr,
                  userAnswer: answers[String(q.id)],
                  correctAnswer: q.correctAnswer
                })))}

أرجع JSON يحتوي على:
{
  "feedbackAr": "تحليل تقييمي دقيق ومحفز في 2-3 جمل باللغة العربية",
  "strengths": ["نقطة قوة 1", "نقطة قوة 2", "نقطة قوة 3"],
  "weaknesses": ["نقطة تحسين 1", "نقطة تحسين 2"]
}`
              }
            ]
          });

          const parsed = JSON.parse(aiRes.choices[0].message?.content || '{}');
          if (parsed.feedbackAr) feedbackAr = parsed.feedbackAr;
          if (Array.isArray(parsed.strengths)) strengths = parsed.strengths;
          if (Array.isArray(parsed.weaknesses)) weaknesses = parsed.weaknesses;
        } catch (aiErr) {
          console.warn('[AssessmentGateway] AI feedback synthesis fallback:', aiErr);
        }
      }

      // 4. Update Database Transactionally
      const completedAt = new Date();
      if (attemptId.includes('-') && !attemptId.startsWith('attempt-')) {
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
    }
  }
}

export const assessmentGateway = new AssessmentGateway();
export const registerAssessmentGateway = (socket: Socket, io?: SocketIOServer) => assessmentGateway.register(socket, io);
