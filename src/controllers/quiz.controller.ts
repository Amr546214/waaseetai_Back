import { Request, Response } from 'express';
import { SpecialtyVerificationStatus, TestSessionStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { DYNAMIC_QUIZ_QUESTION_COUNT, DYNAMIC_QUIZ_RESPONSE_SCHEMA, DYNAMIC_QUIZ_SYSTEM_PROMPT, DynamicQuizGenerationResult, DynamicQuizPayload, DynamicQuizQuestion, isValidDynamicQuizGenerationResult } from '../prompts/quiz.prompt';
import { geminiClient } from '../services/ai/gemini/gemini.client';
import { ioInstance } from '../socket';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';
import { assessmentService } from '../services/assessment.service';

const QUIZ_DURATION_MINUTES = 30;
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
 * Generates a realistic 20-question technical quiz fallback in professional Arabic
 * evenly distributed among the provider's selected sub-specialties.
 */
function generateFallback20Questions(specialtyName: string, subSpecialties: string[]): DynamicQuizPayload {
  const subs = subSpecialties && subSpecialties.length > 0 ? subSpecialties : [specialtyName || 'التطوير والهندسة التقنية'];
  const questions: DynamicQuizQuestion[] = [];
  
  const sampleScenarios = [
    {
      q: 'ما هو التدبير الأمني ومعيار التوثيق الأحدث لضمان استمرار العمل دون انقضاء صلاحيات الرموز (Tokens) في بيئات الخدمات المصغرة (Microservices)؟',
      options: [
        'تخزين كلمات المرور صالحة للأبد في متصفح العميل بدون تشفير',
        'استخدام بنية JWT مع Refresh Token محمي داخل ملفات تعريف ارتباط آمنة (HttpOnly Cookies) وتطبيق تدوير الرموز',
        'الاعتماد على جلسات الذاكرة الفردية على خادم واحد دون مزامنة',
        'تعطيل تدابير الحماية اللاسلكية وبروتوكولات TLS لتسريع الاتصال'
      ],
      correctIndex: 1,
      exp: 'يضمن التدبير المعتمد على تدوير الرموز وتخزينها في HttpOnly Cookies عزل ثغرات XSS وضمان أمان الجلسة على النطاق الموزع.'
    },
    {
      q: 'عند توافق الأداء البطيء مع التحميل المتدفق للبيانات في الواجهات الأمامية، أي نمط تصميمي هو الأفضل تقنياً؟',
      options: [
        'جلب قاعدة البيانات كاملة إلى ذاكرة المتصفح عند بدء التطبيق',
        'تطبيق التمرير اللانهائي (Infinite Scrolling) مع الترقيم الافتراضي (Virtual Scrolling) ومحاذاة DOM التدريجية',
        'تعطيل جدران الحماية وتقليل طبقة الأنماط التنسيقية CSS',
        'إعادة تحميل الصفحة بالكامل عند الضغط على أي عنصر تحكم في الشاشة'
      ],
      correctIndex: 1,
      exp: 'الترقيم الافتراضي يختزل عناصر DOM في الذاكرة لتطابق الأصول المعروضة على الحيز المشيد فقط مما يلغي الاختناقات الذاكرية.'
    },
    {
      q: 'في حالة حدوث عطل تزامني (Race Condition) أثناء التعامل مع المعاملات المالية الحساسة، كيف تتفادي خسارة وتناقض البيانات؟',
      options: [
        'تجاهل القيود السجلية والاعتماد على إدخال القيم بأوامر مباشرة',
        'تطبيق أقفال قاعدة البيانات (Pessimistic/Optimistic Locking) والمعاملات الذرية (Atomic ACID Transactions)',
        'انتظار فترة ثابتة قدرها خمس ثوانٍ بين كل عملية وأخرى برمجياً',
        'حذف السجل وإعادة إنشائه بصلاحيات إدارية كاملة دون مراقبة الأخطاء'
      ],
      correctIndex: 1,
      exp: 'المعاملات الذرية وأقفال قاعدة البيانات هي الضمانة الوحيدة وفق معايير ACID لتجنب تداخل القراءة والكتابة المتزامنة.'
    },
    {
      q: 'ما هو أفضل منهج لاختبار توافق البرمجيات وكشف ثغرات الانحدار (Regression) قبل نشر الإصدارات الحية؟',
      options: [
        'إجراء الفحص اليدوي المرتاد من قبل مطور واحد قبل النشر مباشرة',
        'بناء خط أنابيب CI/CD يشمل اختبارات الوحدة والدخول المتكامل والاختبار العشوائي (Fuzz Testing) بشكل أوتوماتيكي',
        'نشر التعديلات مباشرة على السيرفر الحي ومراقبة شكاوى العملاء الفورية',
        'تشفير قاعدة البيانات لمنع وصول أي اختبار أوتوماتيكي للمنظومة'
      ],
      correctIndex: 1,
      exp: 'خط أنابيب CI/CD المتكامل يلغي العامل الخاطئ البشري ويضمن استيفاء كافة فحوصات التراجع قبل صعود التنسيقات.'
    },
    {
      q: 'عند إدارة حاوية خدمات على السحابة (Cloud Infrastructure)، ما المقياس التقني الذي يعزز الاستيعاب عند ذروة الطلبات؟',
      options: [
        'تثبيت حجم المعالج والذاكرة على أجهزة مادية غير متغيرة التوزيع',
        'تفعيل التوسع التلقائي الأفقي (Horizontal Auto-Scaling) عبر موازن الأحمال ومقاييس زمن استجابة الـ CPU',
        'إيقاف استقبال المستخدمين الجدُد برمجياً حتى انتهاء أعمال الصباح',
        'توسيع ذاكرة خادم واحد بروتوكولياً دون تقديس مساحة تخفيف الضغط'
      ],
      correctIndex: 1,
      exp: 'التوسع الأفقي عبر موازن الأحمال هو معيار مرونة السحابة الحديث لاستيعاب الذروات الطارئة دون هدر الميزانية التشكيلية.'
    }
  ];

  // Distribute 20 questions evenly across selected subSpecialties
  for (let i = 0; i < 20; i++) {
    const sub = subs[i % subs.length];
    const baseScenario = sampleScenarios[i % sampleScenarios.length];
    
    questions.push({
      id: `q${i + 1}`,
      subSpecialtyTag: sub,
      text: `[تخصص: ${sub}] ${baseScenario.q}`,
      options: [...baseScenario.options],
      correctOptionIndex: baseScenario.correctIndex,
      explanation: baseScenario.exp
    });
  }

  return {
    specialtyName,
    totalQuestions: 20,
    durationMins: QUIZ_DURATION_MINUTES,
    passThresholdPercent: PASSING_THRESHOLD_PERCENT,
    questions
  };
}

/**
 * REST Endpoint: Initialize Quiz Session instantly with real-time Socket streaming preparation
 * Route: POST /api/provider/specialties/:id/quiz/init
 */
export async function initSpecialtyQuiz(req: Request, res: Response): Promise<void> {
  const providerSpecialtyId = String(req.params.id);
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ success: false, message: 'غير مصرح لك بالوصول.' });
    return;
  }

  try {
    const providerSpecialty = await prisma.providerSpecialty.findUnique({
      where: { id: providerSpecialtyId },
      include: {
        specialty: true,
        providerProfile: { include: { user: { select: { id: true, email: true } } } },
        testSessions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!providerSpecialty) {
      res.status(404).json({ success: false, message: 'لم يتم العثور على سجل التخصص المطلوب في قاعدة البيانات.' });
      return;
    }

    // Check for 24-hour anti-cheat or fail lockout
    if (providerSpecialty.lockoutUntil && new Date(providerSpecialty.lockoutUntil).getTime() > Date.now()) {
      const remainingSec = Math.ceil((new Date(providerSpecialty.lockoutUntil).getTime() - Date.now()) / 1000);
      res.status(403).json({
        success: false,
        isLockedOut: true,
        lockoutUntil: providerSpecialty.lockoutUntil,
        remainingSec,
        message: `تم حظر دخول الاختبار مؤقتاً بسبب استنفاذ المحاولات أو انتهاك شروط مكافحة الغش. حاول بعد انقضاء المهلة (متبقي ${Math.ceil(remainingSec / 60)} دقيقة).`
      });
      return;
    }

    // If already approved, return success without new test
    if (providerSpecialty.status === SpecialtyVerificationStatus.APPROVED) {
      res.status(200).json({
        success: true,
        isAlreadyApproved: true,
        quizScore: providerSpecialty.quizScore,
        badgeGrantedAt: providerSpecialty.badgeGrantedAt,
        message: 'هذا التخصص معتمد ومفعل بالفعل بالمنصة ولا يتطلب إعادة الاختبار.'
      });
      return;
    }

    // Check if there is an active running session that hasn't timed out
    const latestSession = providerSpecialty.testSessions[0];
    if (latestSession && latestSession.status === TestSessionStatus.IN_PROGRESS) {
      const timeRemainingMs = new Date(latestSession.expiresAt).getTime() - Date.now();
      if (timeRemainingMs > 0) {
        const rawPayload = latestSession.questionsPayload as unknown as DynamicQuizPayload;
        const sanitizedQuestions = (rawPayload.questions || []).map(q => ({
          id: q.id,
          subSpecialtyTag: q.subSpecialtyTag,
          text: q.text,
          options: q.options
        }));

        res.status(200).json({
          success: true,
          data: {
            sessionId: latestSession.id,
            specialtyName: rawPayload.specialtyName,
            totalQuestions: latestSession.totalQuestions,
            durationMins: QUIZ_DURATION_MINUTES,
            expiresAt: latestSession.expiresAt,
            remainingSeconds: Math.floor(timeRemainingMs / 1000),
            questions: sanitizedQuestions,
            isResumed: true,
            isStreaming: false
          }
        });
        return;
      } else {
        await prisma.specialtyTestSession.update({
          where: { id: latestSession.id },
          data: { status: TestSessionStatus.TIMED_OUT }
        });
      }
    }

    // Attempt to fetch unique questions from the database first
    const dbQuestions = await assessmentService.generateUniqueQuiz(providerSpecialty.specialtyId, providerSpecialty.subSpecialties, 20);
    
    let quizPayload: DynamicQuizPayload;
    if (dbQuestions && dbQuestions.length > 0) {
      quizPayload = {
        specialtyName: providerSpecialty.specialty.nameAr || providerSpecialty.specialty.name || 'التخصص المهني',
        totalQuestions: dbQuestions.length,
        durationMins: QUIZ_DURATION_MINUTES,
        passThresholdPercent: PASSING_THRESHOLD_PERCENT,
        questions: dbQuestions
      };
    } else {
      quizPayload = generateFallback20Questions(providerSpecialty.specialty.nameAr || providerSpecialty.specialty.name || 'التخصص المهني', providerSpecialty.subSpecialties);
    }
    
    const expiresAt = new Date(Date.now() + QUIZ_DURATION_MINUTES * 60 * 1000);

    const createdSession = await prisma.specialtyTestSession.create({
      data: {
        userId: providerSpecialty.providerProfile?.user?.id || userId,
        providerSpecialtyId,
        status: TestSessionStatus.IN_PROGRESS,
        totalQuestions: 20,
        correctAnswers: 0,
        scorePercentage: 0.0,
        passed: false,
        antiCheatViolations: 0,
        violationEvents: [] as any,
        questionsPayload: quizPayload as any,
        startedAt: new Date(),
        expiresAt
      }
    });

    res.status(201).json({
      success: true,
      data: {
        sessionId: createdSession.id,
        specialtyName: quizPayload.specialtyName,
        totalQuestions: 20,
        durationMins: QUIZ_DURATION_MINUTES,
        expiresAt: createdSession.expiresAt,
        remainingSeconds: QUIZ_DURATION_MINUTES * 60,
        questions: [],
        isResumed: false,
        isStreaming: true
      }
    });

    // AI-17 background refinement — migrated to the shared Gemini foundation.
    // Fire-and-forget by design (the HTTP response above already returned
    // the DB/static-fallback questions so the client isn't blocked): if a
    // real, fully-validated 20-question Gemini result lands before the
    // client requests the question stream, it silently replaces the
    // session's questionsPayload; otherwise the already-persisted DB/static
    // questions stand unchanged. A malformed or missing GEMINI_API_KEY
    // result is rejected by isValidDynamicQuizGenerationResult and never
    // reaches the database — this was previously trusted directly with no
    // shape validation at all.
    geminiClient.generateStructured<DynamicQuizGenerationResult>(
      `Please generate the ${DYNAMIC_QUIZ_QUESTION_COUNT}-question technical quiz for:\nPrimary Specialty Domain: "${providerSpecialty.specialty.nameAr || providerSpecialty.specialty.name}"\nSelected Sub-Specialties: [${providerSpecialty.subSpecialties.join(', ')}]\nRemember: Strictly generate ${DYNAMIC_QUIZ_QUESTION_COUNT} questions in professional Arabic evenly distributed across these exact sub-specialties.`,
      {
        systemInstruction: DYNAMIC_QUIZ_SYSTEM_PROMPT,
        responseSchema: DYNAMIC_QUIZ_RESPONSE_SCHEMA,
        validate: isValidDynamicQuizGenerationResult,
        temperature: 0.25,
        maxOutputTokens: 4500,
        timeoutMs: 45_000
      }
    ).then(async (result) => {
      const aiPayload: DynamicQuizPayload = {
        specialtyName: quizPayload.specialtyName,
        totalQuestions: DYNAMIC_QUIZ_QUESTION_COUNT,
        durationMins: QUIZ_DURATION_MINUTES,
        passThresholdPercent: PASSING_THRESHOLD_PERCENT,
        questions: result.data.questions
      };
      await prisma.specialtyTestSession.update({
        where: { id: createdSession.id },
        data: { questionsPayload: aiPayload as any }
      });
    }).catch((err: any) => {
      console.warn('[Quiz AI Background Refinement Notice]: Using instant balanced questions.', err?.code || err?.message);
    });
  } catch (error: any) {
    console.error('[Quiz Controller Init Error]:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ غير متوقع أثناء إعداد الاختبار الفوري.', error: error?.message });
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

/**
 * REST Endpoint: Get Quiz Session Status
 * Route: GET /api/provider/specialties/:id/quiz/status
 */
export async function getSpecialtyQuizStatus(req: Request, res: Response): Promise<void> {
  const providerSpecialtyId = String(req.params.id);

  try {
    const spec = await prisma.providerSpecialty.findUnique({
      where: { id: providerSpecialtyId },
      include: {
        testSessions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { submissions: true }
        }
      }
    });

    if (!spec) {
      res.status(404).json({ success: false, message: 'التخصص المطلوب غير موجود.' });
      return;
    }

    const isLockedOut = Boolean(spec.lockoutUntil && new Date(spec.lockoutUntil).getTime() > Date.now());
    const remainingSec = isLockedOut ? Math.ceil((new Date(spec.lockoutUntil!).getTime() - Date.now()) / 1000) : 0;

    res.status(200).json({
      success: true,
      data: {
        providerSpecialtyId: spec.id,
        status: spec.status,
        quizScore: spec.quizScore,
        badgeGrantedAt: spec.badgeGrantedAt,
        isLockedOut,
        lockoutUntil: spec.lockoutUntil,
        remainingSec,
        sessionsHistory: spec.testSessions.map(s => ({
          id: s.id,
          status: s.status,
          scorePercentage: s.scorePercentage,
          passed: s.passed,
          correctAnswers: s.correctAnswers,
          totalQuestions: s.totalQuestions,
          antiCheatViolations: s.antiCheatViolations,
          startedAt: s.startedAt,
          completedAt: s.completedAt
        }))
      }
    });
  } catch (error: any) {
    console.error('[Quiz Status Error]:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء جلب حالة الاختبار.', error: error?.message });
  }
}
