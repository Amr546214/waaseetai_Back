import { OpenAI } from 'openai';
import { logger } from '../../config/logger';
import { structuredAiExecutionService } from '../ai-engine';
import type {
  AiEngineErrorPayload,
  ProjectModelAnalysisAiOutput,
  SuggestedMilestonesAiOutput,
} from '../ai-engine';
import { AppError } from '../../utils/app-error';
import { CompleteProjectDataDto, AiReviewResponse, EnhanceDescriptionDto, SuggestTextDto, SuggestMilestonesDto, SuggestedMilestone } from './ai-review.dto';

const getAiFailureStatusCode = (error: AiEngineErrorPayload): number => {
  if (error.code === 'AI_PROVIDER_RATE_LIMITED') return 429;
  if (
    error.code === 'AI_RESPONSE_VALIDATION_FAILED' ||
    error.code === 'AI_PROVIDER_BAD_RESPONSE'
  ) return 502;

  return error.statusCode && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : 503;
};

const createAiFailureAppError = (
  message: string,
  error: AiEngineErrorPayload
): AppError => {
  return new AppError(message, getAiFailureStatusCode(error), [error]);
};

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
   * Generate intelligent milestone schedule through the shared structured AI Engine.
   */
  async suggestMilestones(
    dto: SuggestMilestonesDto,
    actorUserId?: string
  ): Promise<SuggestedMilestone[]> {
    const result = await structuredAiExecutionService.execute<
      SuggestMilestonesDto,
      SuggestedMilestonesAiOutput
    >({
      capability: 'project_intelligence',
      operation: 'suggest_milestones',
      input: {
        title: dto.title || '',
        description: dto.description || '',
        totalAmount: dto.totalAmount,
      },
      locale: 'ar',
      ...(actorUserId && { auditContext: { actorUserId } }),
    });

    if (!result.success) {
      throw createAiFailureAppError(
        'AI milestone suggestion failed. No simulated milestones were returned.',
        result.error
      );
    }

    return result.data.milestones;
  }

  /**
   * Perform comprehensive AI strategic audit on steps 1-4 through the shared structured AI Engine.
   */
  async analyzeProjectModel(
    data: CompleteProjectDataDto,
    actorUserId?: string
  ): Promise<AiReviewResponse> {
    const result = await structuredAiExecutionService.execute<
      CompleteProjectDataDto,
      ProjectModelAnalysisAiOutput
    >({
      capability: 'project_intelligence',
      operation: 'analyze_project_model',
      input: data,
      locale: 'ar',
      ...(actorUserId && { auditContext: { actorUserId } }),
    });

    if (!result.success) {
      throw createAiFailureAppError(
        'AI project model analysis failed. No simulated analysis was returned.',
        result.error
      );
    }

    return result.data;
  }

}
