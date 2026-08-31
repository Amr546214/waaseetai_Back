import { OpenAI } from 'openai';
import { logger } from '../../config/logger';
import { SYSTEM_PROMPT } from './ai-analyzer.prompt';
import { CompleteProjectDataDto, AiReviewResponse, EnhanceDescriptionDto, SuggestTextDto, SuggestMilestonesDto, SuggestedMilestone } from './ai-review.dto';

export class AiReviewService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      logger.info('🧠 OpenAI Client Initialized in AiReviewService');
    } else {
      logger.warn('⚠️ OPENAI_API_KEY missing in environment variables. AiReviewService will use intelligent simulations.');
    }
  }

  /**
   * Refine and professionalize project description in Step 1 using gpt-4o-mini
   */
  async enhanceDescription(dto: EnhanceDescriptionDto): Promise<string> {
    const { title, description } = dto;
    
    if (this.openai) {
      try {
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are an expert copywriter and product marketing strategist for Waseet AI platform. Rewrite and improve the user submitted service description into a high-converting, professional, and structured Arabic project proposal description. Make it clear, persuasive, and detailed without being overly wordy.'
            },
            {
              role: 'user',
              content: `Project Title: ${title || 'غير محدد'}\nCurrent Description: ${description}`
            }
          ],
          temperature: 0.7,
          max_tokens: 500
        });
        const enhancedText = response.choices[0]?.message?.content;
        if (enhancedText) return enhancedText.trim();
      } catch (error) {
        logger.error(`OpenAI enhanceDescription error: ${error}`);
      }
    }

    // Fallback improvement simulation if OpenAI fails or key is unconfigured
    return `${description.trim()}\n\n★ مميزات إضافية معتمدة من وسيط AI:\n- تنفيذ احترافي وفق معايير الجودة الحديثة وأفضل ممارسات السوق.\n- تسليم مرحلي منظم مع مراجعة شاملة لضمان توافق النتائج بالكامل مع متطلبات العميل.\n- تسليم جميع ملفات المصدر وتوثيق خطوات العمل مع دعم فني ومتابعة مجانية بعد إنجاز الخدمة.`;
  }

  /**
   * Generate a starting draft description based on project title in Step 1 using gpt-4o-mini
   */
  async suggestText(dto: SuggestTextDto): Promise<string> {
    const { title } = dto;
    const effectiveTitle = title || 'خدمة متخصصة';

    if (this.openai) {
      try {
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are Waseet AI creative strategy advisor. Generate an impressive, professional, and comprehensive proposal description in Arabic for a service provider based solely on the service title provided. Mention scope, deliverables, quality assurance, and workflow in simple bulleted or structured paragraphs.'
            },
            {
              role: 'user',
              content: `Generate a full professional description for a project titled: "${effectiveTitle}"`
            }
          ],
          temperature: 0.75,
          max_tokens: 500
        });
        const suggestion = response.choices[0]?.message?.content;
        if (suggestion) return suggestion.trim();
      } catch (error) {
        logger.error(`OpenAI suggestText error: ${error}`);
      }
    }

    // Fallback generation simulation
    return `أقدم لكم خدمة "${effectiveTitle}" باحترافية تامة، مبنية على تحليل عميق لاحتياجات مشروكم وأهدافكم الخاصة.\n\nلماذا تختار هذه الخدمة؟\n- التزام تام بالجدول الزمني وتسليم المخرجات في الوقت المحدد.\n- استخدام أحدث التقنيات والمعايير الفنية لضمان أفضل جودة.\n- تقسيم العمل على مراحل واضحة تشمل العرض، التعديلات، والاعتماد التام.\n- تسليم كامل للملفات والمخرجات بصيغها الأصلية الجاهزة للاستخدام الفوري.`;
  }

  /**
   * Generate intelligent milestone schedule based on project title and description using gpt-4o-mini JSON mode
   */
  async suggestMilestones(dto: SuggestMilestonesDto): Promise<SuggestedMilestone[]> {
    const title = dto.title || 'مشروع جديد';
    const description = dto.description || '';

    if (this.openai) {
      try {
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are Waseet AI Project Manager and Financial Strategist. Given the project title and description, generate a realistic, structured list of 3 to 4 sequential milestones for this project in professional Arabic. Each milestone must have: "title" (string), "description" (string deliverables explanation), "estimatedDays" (integer between 2 and 15), and "percentage" (integer percentage of total payment). The sum of all "percentage" values MUST equal exactly 100. Return strictly a JSON object with a single root key "milestones" containing an array of these milestone objects.'
            },
            {
              role: 'user',
              content: `Project Title: "${title}"\nProject Description: "${description}"\nGenerate optimal operational milestones and payment percentages.`
            }
          ],
          temperature: 0.5,
          max_tokens: 800
        });

        const rawContent = response.choices[0]?.message?.content;
        if (rawContent) {
          const parsed = JSON.parse(rawContent);
          if (Array.isArray(parsed.milestones) && parsed.milestones.length > 0) {
            let milestones: SuggestedMilestone[] = parsed.milestones.map((m: any, idx: number) => ({
              title: m.title || `المرحلة ${idx + 1}`,
              description: m.description || 'إنجاز المخرجات المطلوبة لهذه المرحلة',
              estimatedDays: Number(m.estimatedDays) || 4,
              percentage: Number(m.percentage) || Math.round(100 / parsed.milestones.length)
            }));

            // Ensure exact 100% sum
            const totalPerc = milestones.reduce((sum, m) => sum + (m.percentage || 0), 0);
            if (totalPerc !== 100 && milestones.length > 0) {
              const diff = 100 - totalPerc;
              milestones[milestones.length - 1].percentage = (milestones[milestones.length - 1].percentage || 0) + diff;
            }

            return milestones;
          }
        }
      } catch (error) {
        logger.error(`OpenAI suggestMilestones error: ${error}`);
      }
    }

    // Dynamic smart fallback matching project domain
    const text = (title + ' ' + description).toLowerCase();
    const isDev = text.includes('تطبيق') || text.includes('برمج') || text.includes('تطوير') || text.includes('موقع') || text.includes('ويب') || text.includes('نظام') || text.includes('ذكاء');
    const isDesign = text.includes('هوية') || text.includes('شعار') || text.includes('تصميم') || text.includes('جرافيك') || text.includes('موشن') || text.includes('فيديو');

    if (isDev) {
      return [
        { title: 'التحليل الهندسي وتجهيز البنية التحتية', description: 'تحليل المتطلبات الفنية، إعداد خطة قاعدة البيانات، وتجهيز واجهات الاستخدام التجريبية', estimatedDays: 4, percentage: 25 },
        { title: 'البرمجة الفعلية وتطوير الوظائف الأساسية', description: 'بناء المنظومة البرمجية للربط والتنفيذ ودمج الميزات الحيوية المطلوبة', estimatedDays: 10, percentage: 50 },
        { title: 'الاختبار الشامل والنشر والتشغيل', description: 'فحص الجودة والأداء والتوافقية، تسليم الكود المصدري، مع ضمان تشغيل أولي', estimatedDays: 4, percentage: 25 }
      ];
    } else if (isDesign) {
      return [
        { title: 'دراسة التوجه البصري وتصميم المقترحات الأولية', description: 'تحليل الهوية واقتراح خيارات مبتكرة ومتعددة للتصميم للمناقشة', estimatedDays: 4, percentage: 35 },
        { title: 'تطوير الخيار المعتمد وإعداد الملحقات الفنية', description: 'تجهيز كافة التصاميم التطبيقية وتحديث الألوان والخطوط بناءً على الملاحظات', estimatedDays: 5, percentage: 40 },
        { title: 'تسليم حزمة الملفات الأصلية ودليل الاستخدام', description: 'تجهيز وتصدير جميع ملفات المصدر بالصيغ المفتوحة والطباعية مع إرشادات الهوية', estimatedDays: 3, percentage: 25 }
      ];
    } else {
      return [
        { title: 'التخطيط الاستراتيجي واعتماد خطة العمل', description: 'اجتماع التنسيق الأولي، صياغة خطة العمل التفصيلية واعتماد خارطة المخرجات', estimatedDays: 3, percentage: 30 },
        { title: 'التنفيذ المنهجي وعرض المسودة الرئيسية', description: 'العمل التأسيسي المتكامل وتجهيز مخرجات الخدمة الرئيسية لمراجعة العميل', estimatedDays: 6, percentage: 45 },
        { title: 'المراجعات النهائية والتسليم الختامي للملفات', description: 'تطبيق التعديلات المطلوبة وتسليم كافة المخرجات الأصلية مع ضمان دعم ما بعد الخدمة', estimatedDays: 3, percentage: 25 }
      ];
    }
  }

  /**
   * Perform comprehensive AI strategic audit on steps 1-4 using gpt-4o with response_format json_object
   */
  async analyzeProjectModel(data: CompleteProjectDataDto): Promise<AiReviewResponse> {
    if (this.openai) {
      try {
        const payloadJson = JSON.stringify(data, null, 2);
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: `Please evaluate this proposed project business model:\n${payloadJson}`
            }
          ],
          temperature: 0.5,
          max_tokens: 1500
        });

        const rawContent = response.choices[0]?.message?.content;
        if (rawContent) {
          const parsed = JSON.parse(rawContent) as AiReviewResponse;
          
          // Ensure milestone percentages default correctly if missing
          if (parsed.suggestedMilestones && parsed.suggestedMilestones.length > 0) {
            const count = parsed.suggestedMilestones.length;
            parsed.suggestedMilestones = parsed.suggestedMilestones.map((m, idx) => ({
              ...m,
              percentage: m.percentage || Math.round(100 / count)
            }));
            // fix rounding on last item
            const sum = parsed.suggestedMilestones.reduce((acc, c) => acc + (c.percentage || 0), 0);
            if (sum !== 100 && parsed.suggestedMilestones[count - 1]) {
              parsed.suggestedMilestones[count - 1].percentage! += (100 - sum);
            }
          }
          
          return parsed;
        }
      } catch (error) {
        logger.error(`OpenAI analyzeProjectModel error: ${error}`);
      }
    }

    // Comprehensive Fallback Simulation for testing without OpenAI API Key or offline mode
    return this.getFallbackAnalysis(data);
  }

  private getFallbackAnalysis(data: CompleteProjectDataDto): AiReviewResponse {
    const title = data.title || 'المشروع المقترح';
    const total = data.totalAmount || 4500;
    const stagesCount = data.stages?.length || 2;

    return {
      clarityScore: 92,
      feasibilityScore: 89,
      marketFitRating: 'High',
      executiveSummary: `يعرض مشروع "${title}" هيكلية عمل واضحة وتوزيعاً جيداً للمسؤوليات. يظهر التحليل الذكي أن هذا النموذج يتمتع بقابلية تسويقية عالية (Market Fit: High) ومستوى توافق ممتاز مع رغبات العملاء المؤسسيين والأفراد على حد سواء.`,
      strengths: [
        'وضوح نطاق العمل وتقليل الغموض في تسلسل المخرجات النهائية.',
        'تقسيم المراحل المالية يعزز الثقة المتبادلة ويتماشى مع معايير الضمان في وسيط AI.',
        'تناسب التسعير المقترح مع متوسط قيمة الطلبات المماثلة في القطاع الحالي.'
      ],
      gapsAndRisks: [
        'عدم تفصيل عدد جولات التعديلات المجانية بوضوح في وصف كل مرحلة.',
        stagesCount < 3 ? 'يُستحسن إضافة مرحلة ابتدائية للتحليل والتخطيط التمهيدي قبل البدء بالتنفيذ الفعلي.' : 'قد يتطلب تسليم الملفات النهائية وقتاً أطول للتحقق والاعتماد النهائي.'
      ],
      recommendedImprovements: [
        'تحديد الحد الأقصى للمراجعات المسموح بها في المرحلة قبل النهائية لتجنب تمدد المشروع (Scope Creep).',
        'تضمين وثيقة تسليم رسمية أو دليل استخدام مبسط ضمن مخرجات المرحلة الأخيرة لزيادة القيمة المتفوقة للعرض.'
      ],
      suggestedMilestones: [
        {
          title: 'التحليل التمهيدي وتحديد المتطلبات الفنية',
          estimatedDays: 3,
          description: 'اجتماع مناقشة النขاق وتقديم وثيقة خارطة الطريق والتصميم الأولي',
          percentage: 25
        },
        {
          title: 'التنفيذ الفعلي وتطوير النماذج الرئيسية',
          estimatedDays: 7,
          description: 'بناء وتجهيز المخرجات الأساسية للمشروع وتقديم النسخة التجريبية للمراجعة',
          percentage: 45
        },
        {
          title: 'التعديلات النهائية وتسليم حزمة التشغيل',
          estimatedDays: 4,
          description: 'اعتماد المراجعة النهائية وتسليم ملفات المصدر كاملة مع ضمان دعم فني لمدة شهر',
          percentage: 30
        }
      ],
      suggestedPricingStrategy: {
        recommendedRange: `${Math.round(total * 0.95)} - ${Math.round(total * 1.15)} ريال`,
        reasoning: 'يعتبر هذا النطاق السعري مثالياً لضمان الربحية التنافسية وفي نفس الوقت جذب أصحاب المشاريع ذوي الميزانيات المرتفعة الذين يبحثون عن مخرجات متكاملة ومراحل تسليم موصلة.'
      }
    };
  }
}
