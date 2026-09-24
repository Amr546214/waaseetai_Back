import { OpenAI } from 'openai';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/app-error';
import { geminiClient } from '../../services/ai/gemini/gemini.client';
import { SYSTEM_PROMPT } from './ai-analyzer.prompt';
import { CompleteProjectDataDto, AiReviewResponse, EnhanceDescriptionDto, SuggestTextDto, SuggestMilestonesDto, SuggestedMilestone } from './ai-review.dto';

// ── F1a: suggestMilestones / analyzeProjectModel — migrated to the shared
// Gemini foundation (Batch: F1+F2 streaming). enhanceDescription/suggestText
// below remain on OpenAI: they are the confirmed-dead HTTP twins of the live
// socket implementation (ai-review.gateway.ts, migrated separately) and are
// intentionally out of scope for this batch — see the Batch report's
// DEAD_HTTP_TWIN_CONFIRMED section.

interface GeminiMilestonesPayload {
  milestones: {
    title: string;
    description: string;
    estimatedDays: number;
    percentage: number;
  }[];
}

const MILESTONES_SCHEMA = {
  type: 'object',
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          estimatedDays: { type: 'number', description: 'integer between 2 and 15' },
          percentage: { type: 'number', description: 'integer percentage of total payment' }
        },
        required: ['title', 'description', 'estimatedDays', 'percentage']
      }
    }
  },
  required: ['milestones']
};

// Rejects anything that doesn't genuinely satisfy the milestones contract —
// an empty list, a non-array, or any malformed entry are all invalid, never
// silently patched with a fabricated milestone.
function isValidMilestonesPayload(value: unknown): value is GeminiMilestonesPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.milestones) || v.milestones.length === 0) return false;
  return v.milestones.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const entry = m as Record<string, unknown>;
    return (
      typeof entry.title === 'string' && entry.title.trim().length > 0 &&
      typeof entry.description === 'string' && entry.description.trim().length > 0 &&
      typeof entry.estimatedDays === 'number' && Number.isFinite(entry.estimatedDays) && entry.estimatedDays > 0 &&
      typeof entry.percentage === 'number' && Number.isFinite(entry.percentage) && entry.percentage >= 0 && entry.percentage <= 100
    );
  });
}

const AI_REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    clarityScore: { type: 'number', description: '0 to 100' },
    feasibilityScore: { type: 'number', description: '0 to 100' },
    marketFitRating: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    executiveSummary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    gapsAndRisks: { type: 'array', items: { type: 'string' } },
    recommendedImprovements: { type: 'array', items: { type: 'string' } },
    suggestedMilestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          estimatedDays: { type: 'number' },
          description: { type: 'string' },
          percentage: { type: 'number' }
        },
        required: ['title', 'estimatedDays', 'description']
      }
    },
    suggestedPricingStrategy: {
      type: 'object',
      properties: {
        recommendedRange: { type: 'string' },
        reasoning: { type: 'string' }
      },
      required: ['recommendedRange', 'reasoning']
    }
  },
  required: ['clarityScore', 'feasibilityScore', 'marketFitRating', 'executiveSummary', 'strengths', 'gapsAndRisks', 'recommendedImprovements', 'suggestedMilestones', 'suggestedPricingStrategy']
};

// Rejects anything that doesn't genuinely satisfy the AiReviewResponse
// contract — out-of-range scores, an unrecognized market-fit rating, empty
// string arrays, or a malformed milestone/pricing shape are all invalid,
// never silently patched into a passable-looking result.
function isValidAiReviewResponse(value: unknown): value is AiReviewResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;

  if (typeof v.clarityScore !== 'number' || !Number.isFinite(v.clarityScore) || v.clarityScore < 0 || v.clarityScore > 100) return false;
  if (typeof v.feasibilityScore !== 'number' || !Number.isFinite(v.feasibilityScore) || v.feasibilityScore < 0 || v.feasibilityScore > 100) return false;
  if (v.marketFitRating !== 'High' && v.marketFitRating !== 'Medium' && v.marketFitRating !== 'Low') return false;
  if (typeof v.executiveSummary !== 'string' || v.executiveSummary.trim().length === 0) return false;

  const stringArrayNonEmpty = (arr: unknown): boolean =>
    Array.isArray(arr) && arr.length > 0 && arr.every((s) => typeof s === 'string' && s.trim().length > 0);
  if (!stringArrayNonEmpty(v.strengths)) return false;
  if (!stringArrayNonEmpty(v.gapsAndRisks)) return false;
  if (!stringArrayNonEmpty(v.recommendedImprovements)) return false;

  if (!Array.isArray(v.suggestedMilestones) || v.suggestedMilestones.length === 0) return false;
  const milestonesValid = v.suggestedMilestones.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const entry = m as Record<string, unknown>;
    return (
      typeof entry.title === 'string' && entry.title.trim().length > 0 &&
      typeof entry.description === 'string' && entry.description.trim().length > 0 &&
      typeof entry.estimatedDays === 'number' && Number.isFinite(entry.estimatedDays) && entry.estimatedDays > 0
    );
  });
  if (!milestonesValid) return false;

  const pricing = v.suggestedPricingStrategy as Record<string, unknown> | undefined;
  if (!pricing || typeof pricing !== 'object') return false;
  if (typeof pricing.recommendedRange !== 'string' || pricing.recommendedRange.trim().length === 0) return false;
  if (typeof pricing.reasoning !== 'string' || pricing.reasoning.trim().length === 0) return false;

  return true;
}

export class AiReviewService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      logger.info('🧠 OpenAI Client Initialized in AiReviewService (dead HTTP twins only — see Batch report)');
    } else {
      logger.warn('⚠️ OPENAI_API_KEY missing in environment variables. AiReviewService will use intelligent simulations.');
    }
  }

  /**
   * DEAD HTTP TWIN — confirmed unused by the frontend (the live path is the
   * socket implementation in ai-review.gateway.ts, migrated to Gemini
   * separately). Left on OpenAI intentionally; out of scope for this batch.
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
   * DEAD HTTP TWIN — confirmed unused by the frontend (the live path is the
   * socket implementation in ai-review.gateway.ts, migrated to Gemini
   * separately). Left on OpenAI intentionally; out of scope for this batch.
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
   * F1a — Generate intelligent milestone schedule via the shared Gemini
   * foundation. Honest failure: no dynamic-domain-keyword fallback anymore.
   */
  async suggestMilestones(dto: SuggestMilestonesDto): Promise<SuggestedMilestone[]> {
    const title = dto.title || 'مشروع جديد';
    const description = dto.description || '';

    const systemPrompt = 'You are Waseet AI Project Manager and Financial Strategist. Given the project title and description, generate a realistic, structured list of 3 to 4 sequential milestones for this project in professional Arabic. Each milestone must have: "title" (string), "description" (string deliverables explanation), "estimatedDays" (integer between 2 and 15), and "percentage" (integer percentage of total payment). The sum of all "percentage" values MUST equal exactly 100. Return strictly a JSON object with a single root key "milestones" containing an array of these milestone objects.';
    const userPrompt = `Project Title: "${title}"\nProject Description: "${description}"\nGenerate optimal operational milestones and payment percentages.`;

    try {
      const result = await geminiClient.generateStructured<GeminiMilestonesPayload>(userPrompt, {
        systemInstruction: systemPrompt,
        responseSchema: MILESTONES_SCHEMA,
        validate: isValidMilestonesPayload,
        temperature: 0.5,
        maxOutputTokens: 800
      });

      const milestones: SuggestedMilestone[] = result.data.milestones.map((m) => ({
        title: m.title,
        description: m.description,
        estimatedDays: m.estimatedDays,
        percentage: m.percentage
      }));

      // Preserve the pre-existing exact-100% normalization business rule.
      const totalPerc = milestones.reduce((sum, m) => sum + (m.percentage || 0), 0);
      if (totalPerc !== 100 && milestones.length > 0) {
        const diff = 100 - totalPerc;
        milestones[milestones.length - 1].percentage = (milestones[milestones.length - 1].percentage || 0) + diff;
      }

      return milestones;
    } catch (error) {
      logger.error(`Gemini suggestMilestones error: ${error}`);
      // Honest failure — no domain-keyword-matched canned milestone set.
      throw new AppError('تعذر اقتراح مراحل المشروع عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.', 503);
    }
  }

  /**
   * F1a — Perform comprehensive AI strategic audit via the shared Gemini
   * foundation. Honest failure: no fabricated clarity/feasibility scores or
   * canned strengths/risks/pricing.
   */
  async analyzeProjectModel(data: CompleteProjectDataDto): Promise<AiReviewResponse> {
    const payloadJson = JSON.stringify(data, null, 2);
    const userPrompt = `Please evaluate this proposed project business model:\n${payloadJson}`;

    try {
      const result = await geminiClient.generateStructured<AiReviewResponse>(userPrompt, {
        systemInstruction: SYSTEM_PROMPT,
        responseSchema: AI_REVIEW_RESPONSE_SCHEMA,
        validate: isValidAiReviewResponse,
        temperature: 0.5,
        maxOutputTokens: 1500
      });

      const parsed = result.data;

      // Preserve the pre-existing milestone-percentage normalization rule.
      if (parsed.suggestedMilestones && parsed.suggestedMilestones.length > 0) {
        const count = parsed.suggestedMilestones.length;
        parsed.suggestedMilestones = parsed.suggestedMilestones.map((m) => ({
          ...m,
          percentage: m.percentage || Math.round(100 / count)
        }));
        const sum = parsed.suggestedMilestones.reduce((acc, c) => acc + (c.percentage || 0), 0);
        if (sum !== 100 && parsed.suggestedMilestones[count - 1]) {
          parsed.suggestedMilestones[count - 1].percentage! += (100 - sum);
        }
      }

      return parsed;
    } catch (error) {
      logger.error(`Gemini analyzeProjectModel error: ${error}`);
      // Honest failure — no fabricated scores/strengths/risks/pricing.
      throw new AppError('تعذر تقييم نموذج المشروع عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.', 503);
    }
  }
}
