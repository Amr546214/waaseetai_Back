import { PrismaClient, AssessmentStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import OpenAI from 'openai';
import { aiAssessmentAnalyzerService } from './ai-assessment-analyzer.service';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key_for_build',
  timeout: 60 * 1000,
});

export interface GeneratedQuestionOption {
  id: string; // 'a', 'b', 'c', 'd'
  text: string;
}

export interface GeneratedQuestion {
  id: number | string;
  textAr: string;
  options: GeneratedQuestionOption[];
  correctAnswer?: string;
  explanation?: string;
  assessmentArea?: string;
}

export interface GenerateAssessmentResponse {
  attemptId: string;
  questions: Omit<GeneratedQuestion, 'correctAnswer'>[];
  timeLimitMinutes: number;
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
    const specialtyNameEn = specialty.nameEn || '';
    const categoryName = specialty.category?.nameAr || '';
    const description = specialty.description || '';
    const subSpecialties = providerSpecialty.subSpecialties || [];

    // 2. Portfolio metadata context
    const workSamplesContext = providerSpecialty.workSamples.map(ws => ({
      title: ws.title,
      description: ws.description
    }));

    const portfolioContext = providerSpecialty.providerProfile.portfolioItems.map(p => ({
      title: p.title,
      description: p.description
    }));

    // 3. Fetch last 3 attempts for anti-duplication context
    const previousAttempts = await prisma.assessmentAttempt.findMany({
      where: {
        providerSpecialtyId,
        providerProfileId: providerSpecialty.providerProfileId
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { questionsPayload: true }
    });

    const previousQuestionTexts: string[] = [];
    previousAttempts.forEach(attempt => {
      const payload = attempt.questionsPayload as any;
      if (Array.isArray(payload)) {
        payload.forEach((q: any) => {
          if (q?.textAr) previousQuestionTexts.push(q.textAr);
        });
      } else if (payload?.questions && Array.isArray(payload.questions)) {
        payload.questions.forEach((q: any) => {
          if (q?.textAr) previousQuestionTexts.push(q.textAr);
        });
      }
    });

    // 4. OpenAI Prompt Setup for generating 5 MCQs
    const systemPrompt = `أنت خبير فني وكبير مهندسي تقييم الكفاءات والاعتماد الفني في منصة "وسيط AI".
وظيفتك توليد اختبار تقييمي احترافي مكون من 5 أسئلة خيارات متعددة (MCQs) باللغة العربية، مصممة خصيصاً لقياس المستوى الفني لمقدم الخدمة.

تعليمات صارمة:
1. الأسئلة يجب أن تكون عملية، قائمة على سيناريوهات واقعية ومشاكل تقنية غير مكررة.
2. يتكون كل سؤال من 4 خيارات (id: 'a', 'b', 'c', 'd') مع تحديد الإجابة الصحيحة وشرح دقيق للإجابة.
3. تجنب الأسئلة السابقة التالية لتفادي التكرار:
${previousQuestionTexts.length > 0 ? previousQuestionTexts.map((t, idx) => `${idx + 1}. ${t}`).join('\n') : 'لا يوجد أسئلة سابقة.'}

يجب إرجاع النتيجة حصراً بصيغة JSON التالية:
{
  "questions": [
    {
      "id": 1,
      "textAr": "نص السؤال باللغة العربية...",
      "options": [
        { "id": "a", "text": "الخيار الأول" },
        { "id": "b", "text": "الخيار الثاني" },
        { "id": "c", "text": "الخيار الثالث" },
        { "id": "d", "text": "الخيار الرابع" }
      ],
      "correctAnswer": "a",
      "explanation": "توضيح وشرح سبب صحة الخيار..."
    }
  ]
}`;

    const userPrompt = `التخصص الرئيسي: ${specialtyNameAr} (${specialtyNameEn})
القسم: ${categoryName}
الوصف: ${description}
التخصصات الفرعية المختارة: ${subSpecialties.join(', ')}
نماذج الأعمال المرفوعة: ${JSON.stringify(workSamplesContext)}
معلومات معرض الأعمال: ${JSON.stringify(portfolioContext)}

قم بتوليد 5 أسئلة تقنية متقدمة وشديدة التحدي تناسب هذا التخصص تماماً.`;

    let generatedQuestions: GeneratedQuestion[] = [];

    try {
      const generated = await aiAssessmentAnalyzerService.generate20Questions({
        providerSpecialtyId,
        specialtyId: providerSpecialty.specialtyId,
        subSpecialties,
        categoryName,
        specialtyName: specialtyNameAr,
        providerProfileId: providerSpecialty.providerProfileId
      });
      generatedQuestions = generated.questions;
    } catch (error) {
      console.error('[AiAssessmentService] OpenAI generation failed, applying realistic dynamic fallback:', error);
    }

    // Fallback if OpenAI failed or returned empty
    if (!generatedQuestions || generatedQuestions.length === 0) {
      generatedQuestions = this.getFallbackQuestions(specialtyNameAr, subSpecialties);
    }

    // 5. Store Attempt in Database
    const attempt = await prisma.assessmentAttempt.create({
      data: {
        providerSpecialtyId,
        providerProfileId: providerSpecialty.providerProfileId,
        specialtyId: providerSpecialty.specialtyId,
        questionsPayload: generatedQuestions as any,
        status: AssessmentStatus.IN_PROGRESS,
        timeLimitMinutes: 15,
        startedAt: new Date()
      }
    });

    // 6. Strip correctAnswer before sending to frontend
    const sanitizedQuestions = generatedQuestions.map(q => ({
      id: q.id,
      textAr: q.textAr,
      options: q.options.map(opt => ({ id: opt.id, text: opt.text })),
      assessmentArea: q.assessmentArea,
      explanation: undefined
    }));

    return {
      attemptId: attempt.id,
      questions: sanitizedQuestions,
      timeLimitMinutes: 15
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
    const questionsPayload = (attempt.questionsPayload as unknown as GeneratedQuestion[]) || [];
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

    // 3. AI Feedback Generation via OpenAI
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

    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key_for_build') {
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
        })))}

قم بإرجاع JSON باللغة العربية يحتوي على:
{
  "feedbackAr": "ملخص تقييمي مشجع واحترافي من 2-3 جمل",
  "strengths": ["نقطة قوة 1", "نقطة قوة 2"],
  "weaknesses": ["نقطة تحسين 1", "نقطة تحسين 2"]
}`;

        const aiFeedbackRes = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'أنت محرك تقييم ذكي ومحلل كفاءات فنية لمنصة وسيط AI.' },
            { role: 'user', content: feedbackPrompt }
          ]
        });

        const fbContent = aiFeedbackRes.choices[0].message?.content || '{}';
        const parsedFb = JSON.parse(fbContent);
        if (parsedFb.feedbackAr) feedbackAr = parsedFb.feedbackAr;
        if (Array.isArray(parsedFb.strengths)) strengths = parsedFb.strengths;
        if (Array.isArray(parsedFb.weaknesses)) weaknesses = parsedFb.weaknesses;
      } catch (err) {
        console.warn('[AiAssessmentService] AI feedback generation fallback used:', err);
      }
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

  /**
   * Realistic fallback questions generator for dynamic offline stability
   */
  private getFallbackQuestions(specialtyName: string, subSpecialties: string[]): GeneratedQuestion[] {
    const subs = subSpecialties.length > 0 ? subSpecialties : [specialtyName];
    
    const baseQuestions: GeneratedQuestion[] = [
      {
        id: 1,
        textAr: `في تخصص [${subs[0]}]: ما هو التدبير الهيكلي والأمني الأمثل لمنع ثغرات XSS وتأمين الجلسات الحساسة؟`,
        options: [
          { id: 'a', text: 'تخزين الرموز غير المشفرة في LocalStorage دون حماية' },
          { id: 'b', text: 'استخدام بنية HttpOnly Cookies مع تدوير الرموز (Token Rotation)' },
          { id: 'c', text: 'إلغاء قيود الجلسة والاعتماد على IP العميل فقط' },
          { id: 'd', text: 'تعطيل تشفير TLS لتسريع وقت استجابة الشبكة' }
        ],
        correctAnswer: 'b',
        explanation: 'تضمن HttpOnly Cookies منع وصول نصوص JavaScript الضارة للرموز وتمنع تسريب الجلسات.'
      },
      {
        id: 2,
        textAr: `عند تصميم واجهات عالية الأداء تتعامل مع كميات ضخمة من البيانات في [${subs[1 % subs.length]}]: أي الآليات التالية أنسب؟`,
        options: [
          { id: 'a', text: 'جلب البيانات الكاملة دفعة واحدة في ذاكرة الصفحة' },
          { id: 'b', text: 'تطبيق التمرير الافتراضي (Virtual Scrolling) والترقيم التدريجي (Pagination)' },
          { id: 'c', text: 'إعادة تحميل الهيكل الخارجي للمتصفح عند كل تحديث' },
          { id: 'd', text: 'تقليل حقول قاعدة البيانات بدون تنقية السجلات' }
        ],
        correctAnswer: 'b',
        explanation: 'الترقيم الافتراضي يقلل عدد عناصر DOM المحملة في الذاكرة لتطابق فقط الحيز المرئي للمستخدم.'
      },
      {
        id: 3,
        textAr: `في حالة حدوث عطل تزامني (Race Condition) أثناء معالجة البيانات الحساسة في [${subs[2 % subs.length]}]: كيف تضمن الاتساق الكلي؟`,
        options: [
          { id: 'a', text: 'الاعتماد على إدخال القيم بأوامر مباشرة دون معاملات' },
          { id: 'b', text: 'تطبيق المعاملات الذرية (Atomic ACID Transactions) وأقفال قاعدة البيانات' },
          { id: 'c', text: 'إضافة تأخير زمني محدد بخمس ثوانٍ بين المعاملات' },
          { id: 'd', text: 'إعادة إنشاء الجداول تلقائياً عند حدوث الخطأ' }
        ],
        correctAnswer: 'b',
        explanation: 'المعاملات الذرية وأقفال قاعدة البيانات تضمن مبدأ الكل أو لا شيء وتفادي تضارب البيانات المتزامنة.'
      },
      {
        id: 4,
        textAr: `ما هو النهج المعياري لضمان سلامة النشر وعدم تراجع الأداء (Regression) في بيئات [${subs[3 % subs.length] || subs[0]}]؟`,
        options: [
          { id: 'a', text: 'الفحص اليدوي المرتجل قبل النشر المباشر' },
          { id: 'b', text: 'بناء خط أنابيب CI/CD يشمل اختبارات الوحدة والدخول المتكامل تلقائياً' },
          { id: 'c', text: 'نشر التغييرات على البيئة الحية ومراقبة البلاغات' },
          { id: 'd', text: 'تعطيل سجلات الأخطاء لمنع التوقف الطارئ' }
        ],
        correctAnswer: 'b',
        explanation: 'خطوط CI/CD الأوتوماتيكية تضمن تشغيل كافة الفحوصات واكتشاف العيوب قبل الوصول للمستخدمين.'
      },
      {
        id: 5,
        textAr: `عند إدارة وتوسيع البنية التحتية البرمجية لتستوعب الذروات العالية في [${specialtyName}]: ما الممارسة الأجود؟`,
        options: [
          { id: 'a', text: 'تثبيت أحجام الخوادم ومنع اتساع النطاق' },
          { id: 'b', text: 'تطبيق التوسع التلقائي الأفقي (Horizontal Auto-Scaling) عبر موازن الأحمال' },
          { id: 'c', text: 'إغلاق الوصول برمجياً أثناء أوقات الضغط' },
          { id: 'd', text: 'زيادة مساحة القرص الصلب فقط دون زيادة قدرة المعالجة' }
        ],
        correctAnswer: 'b',
        explanation: 'التوسع الأفقي يوزع الطلبات ديناميكياً عبر عدة خوادم عند ارتفاع الحمل دون انقطاع الخدمة.'
      }
    ];
    return Array.from({ length: 20 }, (_, index) => {
      const source = baseQuestions[index % baseQuestions.length];
      const assessmentArea = index < 5 ? 'التخصص الرئيسي' : index < 10 ? 'التخصص الفرعي' : index < 15 ? 'نموذج العمل والتقنيات' : 'مهارات العميل والصفقات';
      return { ...source, id: index + 1, textAr: `${source.textAr} (${index + 1}/20)`, assessmentArea };
    });
  }
}

export const aiAssessmentService = new AiAssessmentService();
