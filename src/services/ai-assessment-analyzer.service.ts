import { prisma } from '../config/db';
import { geminiClient } from './ai/gemini/gemini.client';

// Shared 20-question generation engine — used by BOTH F12 (ai-assessment
// REST, as its primary path and legacy-compat HTTP fallback) and F14
// (assessment.gateway.ts socket flow, the primary live path). Consolidating
// on this single engine is what makes F12 and F14 "the same conceptual
// assessment" rather than two independently-drifting implementations —
// see the Batch report's caller graph.

export interface GeneratedOption {
  id: string; // 'a', 'b', 'c', 'd'
  text: string;
}

// Canonical application-owned question schema for the whole assessment
// pipeline (F12 + F14 both converge on this shape — F12's own previous
// `GeneratedQuestion` duplicate interface has been removed in favor of it).
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

export type AssessmentGenerationSource = 'GEMINI' | 'STATIC_FALLBACK';

export interface AnalyzePortfolioAndSpecialtyInput {
  providerSpecialtyId: string;
  specialtyId: string;
  subSpecialties?: string[];
  portfolioFileUrls?: string[];
  categoryName?: string;
  specialtyName?: string;
  providerProfileId?: string;
  signal?: AbortSignal;
}

const VALID_OPTION_IDS = new Set(['a', 'b', 'c', 'd']);
const VALID_DIFFICULTIES = new Set(['FUNDAMENTAL', 'PRACTICAL', 'SENIOR_SYSTEM_DESIGN']);

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          textAr: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string', enum: ['a', 'b', 'c', 'd'] }, text: { type: 'string' } },
              required: ['id', 'text']
            }
          },
          correctAnswer: { type: 'string', enum: ['a', 'b', 'c', 'd'] },
          explanation: { type: 'string' },
          assessmentArea: { type: 'string' },
          timeLimitSeconds: { type: 'number' }
        },
        required: ['id', 'textAr', 'options', 'correctAnswer', 'explanation']
      }
    }
  },
  required: ['questions']
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// Rejects anything that doesn't genuinely satisfy the question contract —
// wrong option count/ids, an invalid correctAnswer, or missing text are all
// invalid, never silently patched with a placeholder ("خيار أ", a hardcoded
// correctAnswer of 'b', etc. — the previous implementation did exactly
// this, which is removed).
function isValidQuestionsPayload(value: unknown): value is { questions: AssessmentQuestion[] } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.questions) || v.questions.length < 10) return false;

  return v.questions.every((q) => {
    if (!q || typeof q !== 'object') return false;
    const entry = q as Record<string, unknown>;
    if (!isNonEmptyString(entry.textAr)) return false;
    if (!isNonEmptyString(entry.correctAnswer) || !VALID_OPTION_IDS.has(entry.correctAnswer.toLowerCase())) return false;
    if (!isNonEmptyString(entry.explanation)) return false;
    if (!Array.isArray(entry.options) || entry.options.length !== 4) return false;

    const seenOptionIds = new Set<string>();
    const optionsValid = entry.options.every((opt) => {
      if (!opt || typeof opt !== 'object') return false;
      const o = opt as Record<string, unknown>;
      if (typeof o.id !== 'string' || !VALID_OPTION_IDS.has(o.id.toLowerCase())) return false;
      if (seenOptionIds.has(o.id.toLowerCase())) return false; // duplicate option id
      seenOptionIds.add(o.id.toLowerCase());
      return isNonEmptyString(o.text);
    });
    if (!optionsValid) return false;
    // The declared correct answer must actually reference one of the 4 options.
    if (!seenOptionIds.has((entry.correctAnswer as string).toLowerCase())) return false;

    if (entry.difficulty !== undefined && !VALID_DIFFICULTIES.has(entry.difficulty as string)) return false;

    return true;
  });
}

export class AiAssessmentAnalyzerService {
  /**
   * Generates 20 practical, portfolio-aware questions via the shared Gemini
   * foundation. On any provider failure, invalid/malformed output, or fewer
   * than 20 validated questions, falls back to a genuine deterministic
   * static question bank (generateFallback20Questions) — never a
   * partially-patched, half-fabricated "success".
   */
  async generate20Questions(input: AnalyzePortfolioAndSpecialtyInput): Promise<{
    questions: AssessmentQuestion[];
    subSpecialtiesSnapshot: string[];
    analyzedAssetsSnapshot: any[];
    generationSource: AssessmentGenerationSource;
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
- الحقل "assessmentArea" يجب أن يطابق حرفياً اسم الوحدة المحدد أعلاه لكل مجموعة من خمسة أسئلة.`;

    const userPrompt = `القسم الرئيسي: ${categoryNameAr}
التخصص: ${specialtyNameAr}
التخصصات الفرعية: ${subSpecsText}
تحليل ملفات وعروض المعرض والمشاريع: ${portfolioText}

قم بتوليد 20 سؤالاً وفق توزيع 5+5+5+5 الإلزامي، مع تخصيص أسئلة نموذج العمل من البيانات المرفقة، وجعل آخر خمسة أسئلة مهنية لاختبار قدرة مقدم الخدمة على إقناع العميل وكسب الصفقة.`;

    let questions: AssessmentQuestion[] = [];
    let generationSource: AssessmentGenerationSource = 'STATIC_FALLBACK';

    try {
      const result = await geminiClient.generateStructured<{ questions: AssessmentQuestion[] }>(userPrompt, {
        systemInstruction: systemPrompt,
        responseSchema: QUESTIONS_SCHEMA,
        validate: isValidQuestionsPayload,
        temperature: 0.3,
        maxOutputTokens: 4000,
        signal: input.signal
      });

      questions = result.data.questions.slice(0, 20).map((q, idx) => ({
        ...q,
        timeLimitSeconds: q.timeLimitSeconds || 45,
        assessmentArea: this.getAssessmentArea(idx)
      }));
      generationSource = 'GEMINI';
    } catch (err) {
      console.warn('[AiAssessmentAnalyzerService] Gemini generation failed, producing high-caliber static fallback set:', (err as any)?.code || (err as Error)?.message);
    }

    // Honest static fallback if Gemini unavailable, invalid, or returned fewer than 20 usable questions.
    if (!questions || questions.length < 20) {
      questions = this.generateFallback20Questions(specialtyNameAr, subSpecs, portfolioItemsMeta);
      generationSource = 'STATIC_FALLBACK';
    }

    return {
      questions,
      subSpecialtiesSnapshot: subSpecs,
      analyzedAssetsSnapshot: portfolioItemsMeta,
      generationSource
    };
  }

  private getAssessmentArea(index: number): string {
    if (index < 5) return 'التخصص الرئيسي';
    if (index < 10) return 'التخصص الفرعي';
    if (index < 15) return 'نموذج العمل والتقنيات';
    return 'مهارات العميل والصفقات';
  }

  /**
   * STATIC FALLBACK — a genuine deterministic product feature, not
   * AI-generated content. Callers must label results built from this as
   * `generationSource: 'STATIC_FALLBACK'`, never as Gemini output.
   */
  generateFallback20Questions(specialtyName: string, subSpecs: string[], portfolioItems: any[]): AssessmentQuestion[] {
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
