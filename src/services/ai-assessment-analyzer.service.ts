import { PrismaClient } from '@prisma/client';
import { prisma } from '../config/db';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key_for_build',
  timeout: 60 * 1000,
});

export interface GeneratedOption {
  id: string; // 'a', 'b', 'c', 'd'
  text: string;
}

export interface AssessmentQuestion {
  id: number | string;
  textAr: string;
  options: GeneratedOption[];
  correctAnswer: string;
  explanation: string;
  timeLimitSeconds?: number;
  difficulty?: 'FUNDAMENTAL' | 'PRACTICAL' | 'SENIOR_SYSTEM_DESIGN';
  assessmentArea?: string;
}

export interface AnalyzePortfolioAndSpecialtyInput {
  providerSpecialtyId: string;
  specialtyId: string;
  subSpecialties?: string[];
  portfolioFileUrls?: string[];
  categoryName?: string;
  specialtyName?: string;
  providerProfileId?: string;
}

export class AiAssessmentAnalyzerService {
  /**
   * Generates 20 practical, multimodal portfolio-aware questions via GPT-4o
   */
  async generate20Questions(input: AnalyzePortfolioAndSpecialtyInput): Promise<{
    questions: AssessmentQuestion[];
    subSpecialtiesSnapshot: string[];
    analyzedAssetsSnapshot: any[];
  }> {
    let specialtyNameAr = input.specialtyName || 'التخصص الفني';
    let categoryNameAr = input.categoryName || 'المجال الفني';
    let subSpecs = input.subSpecialties || [];
    let portfolioUrls = input.portfolioFileUrls || [];
    let portfolioItemsMeta: any[] = [];
    let providerProfileId = input.providerProfileId || '';

    // Fetch deep database context if providerSpecialtyId exists
    if (input.providerSpecialtyId && input.providerSpecialtyId !== 'demo-spec-uuid-101') {
      try {
        const ps = await prisma.providerSpecialty.findUnique({
          where: { id: input.providerSpecialtyId },
          include: {
            specialty: { include: { category: true } },
            providerProfile: {
              include: {
                portfolioItems: true,
                certificates: true
              }
            },
            workSamples: { include: { proofs: true } }
          }
        });

        if (ps) {
          specialtyNameAr = ps.specialty.nameAr || specialtyNameAr;
          categoryNameAr = ps.specialty.category?.nameAr || categoryNameAr;
          if (ps.subSpecialties && ps.subSpecialties.length > 0) {
            subSpecs = ps.subSpecialties;
          }
          providerProfileId = ps.providerProfileId;

          // Merge portfolio items
          portfolioItemsMeta = ps.providerProfile.portfolioItems.map((item: any) => ({
            title: String(item.title || '').slice(0, 180),
            description: String(item.description || '').slice(0, 500),
            hasProjectUrl: Boolean(item.projectUrl),
            imageCount: Array.isArray(item.images) ? item.images.length : 0
          }));

          ps.workSamples.forEach(ws => {
            portfolioItemsMeta.push({
              title: String(ws.title || '').slice(0, 180),
              description: String(ws.description || '').slice(0, 500),
              technologies: ws.technologies.slice(0, 15),
              publicAsset: {
                mimeType: ws.mimeType,
                fileBytes: ws.fileBytes,
                watermarked: true
              },
              proofs: ws.proofs.slice(0, 5).map(p => ({
                fileName: String(p.fileName || '').slice(0, 160),
                mimeType: p.mimeType,
                fileBytes: p.fileBytes,
                confidential: p.isConfidential
              }))
            });
          });
        }
      } catch (dbErr) {
        console.warn('[AiAssessmentAnalyzerService] Could not fetch DB record, using input params:', dbErr);
      }
    }

    const subSpecsText = subSpecs.length > 0 ? subSpecs.join(', ') : specialtyNameAr;
    const safePortfolioFileNames = portfolioUrls
      .filter(url => !url.startsWith('data:'))
      .map(url => url.split('/').pop() || 'portfolio-file')
      .slice(0, 10);
    const portfolioText = portfolioItemsMeta.length > 0
      ? JSON.stringify(portfolioItemsMeta.slice(0, 5)).slice(0, 12_000)
      : (safePortfolioFileNames.length > 0 ? safePortfolioFileNames.join(', ') : 'معرض أعمال محفوظ ومحمِي بعلامة وسيط AI');

    // Build Multimodal GPT-4o System Prompt
    const systemPrompt = `أنت كبير مهندسي ومقيمي الاعتماد التقني بمنصة "وسيط AI".
وظيفتك بناء تقييم تقني فائق الدقة مكون من 20 سؤالاً باللغة العربية (MCQs) لقياس كفاءة مقدم الخدمة.

التوزيع إلزامي ولا يجوز تغييره:
1. الأسئلة 1 إلى 5 — "التخصص الرئيسي": تقيس فهم المجال الرئيسي (${categoryNameAr}) والتخصص (${specialtyNameAr}) ومعاييره المهنية.
2. الأسئلة 6 إلى 10 — "التخصص الفرعي": سيناريوهات عملية موزعة على التخصصات الفرعية المختارة (${subSpecsText}).
3. الأسئلة 11 إلى 15 — "نموذج العمل والتقنيات": أسئلة مخصصة حصراً من بيانات نماذج العمل، طريقة التنفيذ، القرارات، التحديات، والتقنيات المذكورة. لا تخترع تقنية غير موجودة في البيانات.
4. الأسئلة 16 إلى 20 — "مهارات العميل والصفقات": تقيس اكتشاف احتياج العميل، تقديم القيمة، معالجة الاعتراضات، التفاوض، التسعير، بناء الثقة، وإغلاق صفقة مشروع بشكل أخلاقي ومهني.

الشروط الصارمة:
- كل سؤال يتضمن 4 خيارات حصرية مرتبة بأحرف الإدخال: "a", "b", "c", "d".
- خيار محدد كإجابة صحيحة ("correctAnswer": "a" | "b" | "c" | "d").
- شرح دقيق ومعيار مهني واضح لسبب صحة الخيار ("explanation").
- ربط الأسئلة بوضوح بالتخصص الرئيسي، التخصصات الفرعية، وطبيعة أعمال المشاريع المرفوعة.
- الحقل "assessmentArea" يجب أن يطابق حرفياً اسم الوحدة المحدد أعلاه لكل مجموعة من خمسة أسئلة.

قم بإرجاع النتيجة بتنسيق JSON حصراً:
{
  "questions": [
    {
      "id": 1,
      "textAr": "نص السؤال...",
      "options": [
        { "id": "a", "text": "الخيار الأول" },
        { "id": "b", "text": "الخيار الثاني" },
        { "id": "c", "text": "الخيار الثالث" },
        { "id": "d", "text": "الخيار الرابع" }
      ],
      "correctAnswer": "b",
      "explanation": "التعليل الفني...",
	  "assessmentArea": "التخصص الرئيسي",
      "timeLimitSeconds": 45
    }
  ]
}`;

    const userPrompt = `القسم الرئيسي: ${categoryNameAr}
التخصص: ${specialtyNameAr}
التخصصات الفرعية: ${subSpecsText}
تحليل ملفات وعروض المعرض والمشاريع: ${portfolioText}

قم بتوليد 20 سؤالاً وفق توزيع 5+5+5+5 الإلزامي، مع تخصيص أسئلة نموذج العمل من البيانات المرفقة، وجعل آخر خمسة أسئلة مهنية لاختبار قدرة مقدم الخدمة على إقناع العميل وكسب الصفقة.`;

    let questions: AssessmentQuestion[] = [];

    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key_for_build') {
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });

        const content = response.choices[0].message?.content || '{}';
        const parsed = JSON.parse(content);
        if (parsed?.questions && Array.isArray(parsed.questions) && parsed.questions.length >= 10) {
          questions = parsed.questions.slice(0, 20).map((q: any, idx: number) => ({
            id: q.id || idx + 1,
            textAr: q.textAr || q.text || `سؤال تقني في ${specialtyNameAr}`,
            options: Array.isArray(q.options) ? q.options : [
              { id: 'a', text: 'خيار أ' },
              { id: 'b', text: 'خيار ب' },
              { id: 'c', text: 'خيار ج' },
              { id: 'd', text: 'خيار د' }
            ],
            correctAnswer: q.correctAnswer || 'b',
            explanation: q.explanation || 'تم اعتماد الخيار التزاماً بأحدث المعايير البرمجية.',
            timeLimitSeconds: q.timeLimitSeconds || 45,
            assessmentArea: this.getAssessmentArea(idx)
          }));
        }
      } catch (err) {
        console.warn('[AiAssessmentAnalyzerService] OpenAI generation failed, producing high-caliber fallback set:', err);
      }
    }

    // Fallback 20 question generator if OpenAI unavailable or returned partial set
    if (!questions || questions.length < 20) {
      questions = this.generateFallback20Questions(specialtyNameAr, subSpecs, portfolioItemsMeta);
    }

    return {
      questions,
      subSpecialtiesSnapshot: subSpecs,
      analyzedAssetsSnapshot: portfolioItemsMeta
    };
  }

  private getAssessmentArea(index: number): string {
    if (index < 5) return 'التخصص الرئيسي';
    if (index < 10) return 'التخصص الفرعي';
    if (index < 15) return 'نموذج العمل والتقنيات';
    return 'مهارات العميل والصفقات';
  }

  private generateFallback20Questions(specialtyName: string, subSpecs: string[], portfolioItems: any[]): AssessmentQuestion[] {
    const subs = subSpecs.length > 0 ? subSpecs : [specialtyName, 'هندسة البرمجيات', 'الأمان والسرعة'];
    const scenarios = [
      {
        q: 'ما هو بروتوكول المصادقة ومعيار حماية الرموز (Tokens) الأنسب في بيئات الخدمات المصغرة لمنع استغلال الثغرات وتزوير الهوية؟',
        opts: [
          'تخزين كلمات المرور صريحة دون تشفير في ذاكرة العميل',
          'استخدام بنية JWT مع Refresh Token داخل HttpOnly Cookies وتدوير الرموز دورياً',
          'الاعتماد على رقم IP العميل فقط للمصادقة وتخطي التوثيق',
          'تعطيل شهادات SSL/TLS لتقليل وقت الاستجابة'
        ],
        correct: 'b',
        explanation: 'الـ HttpOnly Cookies تمنع الوصول للرموز بواسطة JavaScript وتدوير الرموز يمنع إعادة استخدام الرموز المسروقة.'
      },
      {
        q: 'عند تصميم واجهة مستخدم تتعامل مع تدفق مستمر للبيانات ضخمة الحجم، أي التقنيات تحقق أفضل استهلاك للذاكرة والأداء؟',
        opts: [
          'تحميل البيانات كاملة دفعة واحدة في ذاكرة الصفحات',
          'تطبيق التمرير الافتراضي (Virtual Scrolling) وجلب البيانات بالترقيم التدريجي',
          'إعادة تنشيط متصفح العميل عند كل سجل جديد',
          'حذف الأنماط التنسيقية وتجاهل ضغط الصور'
        ],
        correct: 'b',
        explanation: 'التمرير الافتراضي يرسم فقط العناصر الظاهرة في الشاشة مما يحافظ على خفة الذاكرة وسلاسة الواجهة.'
      },
      {
        q: 'في حالة رصد تضارب تزامني (Race Condition) عند تنفيذ المعاملات الحساسة، كيف تتفادى تكرار البيانات أو فقدان اتساقها؟',
        opts: [
          'تجاهل قيود قاعدة البيانات وإدخال القيم بشكل مباشر',
          'استخدام المعاملات الذرية (Atomic ACID Transactions) وتفعيل أقفال قواعد البيانات',
          'إيقاف الخادم لخمس ثوانٍ بين كل عملية وأخرى',
          'حذف الجدول وإعادة إنشائه تلقائياً عند ظهور الخطأ'
        ],
        correct: 'b',
        explanation: 'تضمن المعاملات الذرية عدم تنفيذ جزء من التغييرات دون بقيتها وأقفال الصفوف تمنع التعديل المتزامن بنفس اللحظة.'
      },
      {
        q: 'ما النهج الموصى به برمجياً لكشف ثغرات الانحدار (Regression) واختبار المكونات قبل النشر في بيئة الإنتاج؟',
        opts: [
          'الفحص اليدوي السريع قبل دقائق من النشر',
          'بناء خط أنابيب CI/CD ينفذ اختبارات الوحدة واختبارات التكامل أوتوماتيكياً',
          'نشر التعديلات فوراً ومراقبة الشكاوى',
          'إغلاق سجلات الأخطاء لمنع ظهور التنبيهات'
        ],
        correct: 'b',
        explanation: 'خطوط الأنابيب التلقائية تمحص الكود مقابل الاختبارات قبل السماح بمروره للبيئة الحية.'
      }
    ];
    const clientScenarios = [
      { q: 'عندما يشرح العميل احتياجاً عاماً وغير واضح، ما التصرف الأكثر مهنية قبل تقديم العرض؟', opts: ['إرسال سعر نهائي فوراً', 'طرح أسئلة اكتشاف محددة وتلخيص النطاق والنتيجة المطلوبة للتأكيد', 'افتراض التفاصيل اعتماداً على مشاريع سابقة', 'وعد العميل بتنفيذ أي شيء ضمن نفس السعر'], correct: 'b', explanation: 'أسئلة الاكتشاف وتأكيد النطاق تمنع سوء الفهم وتُظهر فهماً تجارياً ومهنياً.' },
      { q: 'إذا اعترض العميل على السعر رغم اقتناعه بالجودة، كيف تحافظ على قيمة عرضك وتزيد فرصة إغلاق الصفقة؟', opts: ['تخفيض السعر للنصف فوراً', 'ربط السعر بالنتائج والمخرجات وتقسيم النطاق إلى خيارات واضحة', 'انتقاد ميزانية العميل', 'إنهاء التفاوض مباشرة'], correct: 'b', explanation: 'شرح القيمة وتقديم خيارات نطاق يحافظان على الثقة والسعر ويمنحان العميل قراراً واضحاً.' },
      { q: 'ما الطريقة الأفضل لعرض نموذج العمل السابق حتى يتحول إلى دليل مقنع على قدرتك على تنفيذ مشروع العميل؟', opts: ['عرض الصورة فقط دون سياق', 'شرح المشكلة والدور والتقنيات والنتيجة وربطها باحتياج العميل الحالي', 'ذكر عدد الملفات المستخدمة', 'تقديم جميع الأعمال دون انتقاء'], correct: 'b', explanation: 'دراسة الحالة المختصرة تربط الدليل السابق مباشرة بالقيمة التي يبحث عنها العميل.' },
      { q: 'عند مقارنة العميل عرضك بعرض أرخص، ما الرد الذي يبني الثقة دون الإساءة إلى المنافس؟', opts: ['اتهام المنافس بقلة الخبرة', 'توضيح اختلاف النطاق والجودة وإدارة المخاطر مع احترام خيارات العميل', 'تقديم ضمانات غير واقعية', 'رفض توضيح السعر'], correct: 'b', explanation: 'المقارنة الموضوعية المبنية على القيمة والمخاطر تعزز الثقة وتحافظ على المهنية.' },
      { q: 'بعد موافقة العميل المبدئية، ما الخطوة الأصح لتثبيت الصفقة وتقليل الخلافات أثناء التنفيذ؟', opts: ['بدء العمل دون توثيق', 'توثيق النطاق والمراحل ومعايير القبول والتكلفة والجدول وآلية التغيير', 'طلب كامل المبلغ خارج المنصة', 'ترك المواعيد مفتوحة'], correct: 'b', explanation: 'توثيق الاتفاق ومعايير القبول يحول الموافقة إلى التزام واضح ويحمي الطرفين.' }
    ];

    const questions: AssessmentQuestion[] = [];
    for (let i = 0; i < 20; i++) {
      const sub = subs[i % subs.length];
      const sc = i >= 15 ? clientScenarios[i - 15] : scenarios[i % scenarios.length];
      const workSample = portfolioItems.find(item => Array.isArray(item.technologies)) || {};
      const technologies = Array.isArray(workSample.technologies) && workSample.technologies.length
        ? workSample.technologies.join('، ')
        : 'الأدوات المهنية المناسبة';
      let questionText = sc.q;
      if (i < 5) questionText = `ضمن التخصص الرئيسي «${specialtyName}»: ${sc.q}`;
      else if (i < 10) questionText = `ضمن التخصص الفرعي «${sub}»: ${sc.q}`;
      else if (i < 15) questionText = `في نموذج العمل «${workSample.title || specialtyName}» المنفذ باستخدام (${technologies})، ${sc.q}`;
      else questionText = sc.q;
      questions.push({
        id: i + 1,
        textAr: questionText,
        options: [
          { id: 'a', text: sc.opts[0] },
          { id: 'b', text: sc.opts[1] },
          { id: 'c', text: sc.opts[2] },
          { id: 'd', text: sc.opts[3] }
        ],
        correctAnswer: sc.correct,
        explanation: sc.explanation,
        timeLimitSeconds: 45,
        difficulty: i < 5 ? 'FUNDAMENTAL' : (i < 15 ? 'PRACTICAL' : 'SENIOR_SYSTEM_DESIGN'),
        assessmentArea: this.getAssessmentArea(i)
      });
    }

    return questions;
  }
}

export const aiAssessmentAnalyzerService = new AiAssessmentAnalyzerService();
