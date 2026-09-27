import { Request, Response } from 'express';
import { SpecialtyVerificationStatus, TestSessionStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { DynamicQuizPayload } from '../prompts/quiz.prompt';
import { ioInstance } from '../socket';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';

const PASSING_THRESHOLD_PERCENT = 25.0;

/**
 * Orchestrator helper to emit real-time in-app notification & send Nodemailer email with full quiz results
 */
export async function notifyAndEmailQuizResult(sessionId: string): Promise<void> {
  if (!sessionId) return;

  try {
    const session = await prisma.specialtyTestSession.findUnique({
      where: { id: sessionId },
      include: {
        providerSpecialty: {
          include: {
            specialty: true,
            providerProfile: {
              include: { user: true }
            }
          }
        }
      }
    });

    if (!session || !session.providerSpecialty) {
      console.warn(`[Quiz Notify & Email]: Session or ProviderSpecialty not found for ${sessionId}`);
      return;
    }

    const spec = session.providerSpecialty;
    const providerProfile = spec.providerProfile as any;
    const user = providerProfile?.user || {};
    const userId = user?.id || session.userId;
    if (!userId || !user?.email) return;
    const email = user.email;
    const providerName = user?.name || user?.username || user?.firstName || email.split('@')[0] || 'مقدم الخدمة المتميز';
    const specialtyName = spec.specialty?.nameAr || spec.specialty?.name || 'التخصص المهني';
    const subSpecialties = Array.isArray(spec.subSpecialties) ? (spec.subSpecialties as string[]) : [];

    const isInvalidated = session.status === TestSessionStatus.INVALIDATED;
    const isTimedOut = session.status === TestSessionStatus.TIMED_OUT;
    const isSuccess = session.passed && !isInvalidated && !isTimedOut;

    // 1. Prepare Title & Message for real-time application notification
    let notifTitle = '🎉 مبروك! اجتزت اختبار الاعتماد';
    let notifMessage = `تم تفعيل شارة التميز المهني لتخصص (${specialtyName}) بنجاح وبنسبة اجتياز ${session.scorePercentage}%.`;

    if (isInvalidated) {
      notifTitle = '🚨 إبطال الاختبار وقفل التخصص';
      notifMessage = `تم إبطال الاختبار الفوري لتخصص (${specialtyName}) وتطبيق حظر الإعادة لمدة 24 ساعة بسبب تكرار مخالفة مراقبة المتصفح.`;
    } else if (isTimedOut || !session.passed) {
      notifTitle = '⏳ نتيجة اختبار التخصص المهني';
      notifMessage = `لم تتجاوز الحد الأدنى المطلوب (25%) لاجتياز اختبار (${specialtyName}) - النتيجة: ${session.scorePercentage}%. تم قفل المحاولة لمدة 24 ساعة.`;
    }

    // 2. Dispatch in-app DB notification with real-time Socket.IO emission
    await notificationService.createAndEmitNotification({
      userId,
      title: notifTitle,
      message: notifMessage,
      category: 'AI',
      type: 'AI_QUIZ_RESULT',
      actionUrl: '/provider-overview/profile/specialties',
      actionText: 'عرض تقرير الاختبار ›',
      metadata: {
        sessionId: session.id,
        scorePercentage: session.scorePercentage,
        passed: session.passed,
        status: spec.status,
        lockoutUntil: spec.lockoutUntil
      }
    });

    console.log(`[Quiz Notify & Email]: Real-time in-app notification emitted to user ${userId} for session ${sessionId}`);

    // 3. Send professional HTML Email via Nodemailer
    await emailService.sendSpecialtyQuizResultEmail({
      email,
      providerName,
      specialtyName,
      subSpecialties,
      scorePercentage: session.scorePercentage || 0.0,
      correctAnswers: session.correctAnswers || 0,
      totalQuestions: session.totalQuestions || 20,
      passed: Boolean(session.passed),
      status: spec.status,
      lockoutUntil: spec.lockoutUntil,
      violationCount: session.antiCheatViolations || 0,
      isInvalidated,
      isTimedOut
    });

    console.log(`[Quiz Notify & Email]: Nodemailer task dispatched successfully for email ${email}`);
  } catch (error) {
    console.error(`[Quiz Notify & Email Error]: Failure delivering result notifications for session ${sessionId}:`, error);
  }
}

/**
 * REST Endpoint: Submit Quiz Answers & Atomic Evaluation
 * Route: POST /api/provider/specialties/:id/quiz/submit
 */
export async function submitSpecialtyQuiz(req: Request, res: Response): Promise<void> {
  const providerSpecialtyId = String(req.params.id);
  const userId = req.user?.id;
  const { sessionId, answers, isTimeout } = req.body;

  if (!sessionId || !userId) {
    res.status(400).json({ success: false, message: 'sessionId is required in submission payload.' });
    return;
  }

  try {
    const session = await prisma.specialtyTestSession.findUnique({
      where: { id: String(sessionId) },
      include: {
        providerSpecialty: true
      }
    });

    if (!session) {
      res.status(404).json({ success: false, message: 'سجل الاختبار غير موجود في النظام.' });
      return;
    }

    if (session.providerSpecialtyId !== providerSpecialtyId || session.userId !== userId) {
      res.status(403).json({ success: false, message: 'غير مصرح لك بإرسال نتائج هذا الاختبار.' });
      return;
    }

    if (session.status !== TestSessionStatus.IN_PROGRESS) {
      res.status(400).json({ success: false, message: 'تم إغلاق أو تقييم هذا الاختبار مسبقاً.' });
      return;
    }

    const payload = session.questionsPayload as unknown as DynamicQuizPayload;
    const allQuestions = payload.questions || [];
    const answerArray: Array<{ questionId: string; selectedIndex: number; timeTakenSec?: number }> = Array.isArray(answers) ? answers : [];

    let correctCount = 0;
    const submissionsData = allQuestions.map(q => {
      const userAns = answerArray.find(a => a.questionId === q.id);
      const selectedIndex = userAns !== undefined ? Number(userAns.selectedIndex) : -1;
      const isCorrect = selectedIndex === q.correctOptionIndex;
      if (isCorrect) correctCount++;

      return {
        questionId: q.id,
        subSpecialtyTag: q.subSpecialtyTag || 'عام',
        selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
        isCorrect,
        timeTakenSec: userAns?.timeTakenSec || 0,
      };
    });

    const totalQuestions = allQuestions.length || 20;
    const scorePercentage = parseFloat(((correctCount / totalQuestions) * 100).toFixed(1));
    const passed = scorePercentage > PASSING_THRESHOLD_PERCENT;
    const targetStatus = isTimeout && !passed ? TestSessionStatus.TIMED_OUT : TestSessionStatus.COMPLETED;

    // Atomic database write via prisma.$transaction
    const [updatedSession, updatedSpecialty] = await prisma.$transaction(async (tx) => {
      const sess = await tx.specialtyTestSession.update({
        where: { id: session.id },
        data: {
          status: targetStatus,
          correctAnswers: correctCount,
          scorePercentage,
          passed,
          completedAt: new Date(),
          submissions: {
            create: submissionsData
          }
        },
        include: { submissions: true }
      });

      let specStatus = passed ? SpecialtyVerificationStatus.APPROVED : SpecialtyVerificationStatus.REJECTED;
      const updateData: any = {
        hasTakenAssessment: true,
        latestScore: scorePercentage,
        isPassed: passed,
        passedAt: passed ? new Date() : null,
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
        where: { id: providerSpecialtyId },
        data: updateData
      });

      return [sess, spec];
    });

    if (ioInstance) {
      ioInstance.to(`quiz_${session.id}`).emit('quiz:result', {
        sessionId: session.id,
        passed,
        scorePercentage,
        correctCount,
        totalQuestions,
        status: updatedSpecialty.status,
        badgeGrantedAt: updatedSpecialty.badgeGrantedAt,
        lockoutUntil: updatedSpecialty.lockoutUntil
      });
    }

    // Trigger real-time app notification and Nodemailer email delivery asynchronously
    notifyAndEmailQuizResult(updatedSession.id).catch(err => console.error('[Quiz Submit Notify Error]:', err));

    const detailedResults = allQuestions.map(q => {
      const userAns = answerArray.find(a => a.questionId === q.id);
      return {
        questionId: q.id,
        text: q.text,
        subSpecialtyTag: q.subSpecialtyTag,
        options: q.options,
        selectedIndex: userAns !== undefined ? userAns.selectedIndex : -1,
        correctOptionIndex: q.correctOptionIndex,
        isCorrect: (userAns?.selectedIndex === q.correctOptionIndex),
        explanation: q.explanation
      };
    });

    res.status(200).json({
      success: true,
      message: passed 
        ? '✓ مبروك! لقد اجتزت الاختبار الفوري بنجاح وتم اعتماد تخصصك بشارة التميز الرسمية!'
        : 'لم تتجاوز نسبة الاجتياز المطلوبة (25%). تم قفل إعادة الاختبار لمدة 24 ساعة وفق نظام مكافحة التلاعب.',
      data: {
        sessionId: updatedSession.id,
        passed,
        scorePercentage,
        correctAnswers: correctCount,
        totalQuestions,
        status: updatedSpecialty.status,
        badgeGrantedAt: updatedSpecialty.badgeGrantedAt,
        lockoutUntil: updatedSpecialty.lockoutUntil,
        detailedResults
      }
    });
  } catch (error: any) {
    console.error('[Quiz Submit Error]:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ داخلي أثناء معالجة نتائج الاختبار.', error: error?.message });
  }
}
