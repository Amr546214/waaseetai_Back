import OpenAI from 'openai';
import { prisma } from '../utils/prisma.client';
import { AppError } from '../utils/app-error';

export interface AiPriceAudit {
  recommendedMin: number;
  recommendedMax: number;
  priceTag: 'UNDERPRICED' | 'FAIR' | 'OVERPRICED';
  justification: string;
}

export interface AiProposalFeedback {
  suggestedTitle: string;
  suggestedMessage: string;
  qualityScore: number;
  qualityTag: 'POOR' | 'MEDIUM' | 'GOOD' | 'EXCELLENT';
  priceAudit: AiPriceAudit;
  recommendedAdvantages: string[];
}

class AiProposalService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  /**
   * Evaluates the provider's draft proposal against targeted project specs and generates structured AI refinement feedback.
   */
  public async evaluateAndSuggestProposal(
    projectId: string,
    currentTitle?: string,
    currentMessage?: string,
    advantages: string[] = []
  ): Promise<AiProposalFeedback> {
    // 1. Fetch targeted project details
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        title: true,
        description: true,
        budgetMin: true,
        budgetMax: true,
        budgetFixed: true,
        deliveryDays: true,
        requirements: true,
        specialty: true
      }
    });

    if (!project) {
      throw new AppError('المشروع المحدد غير موجود في قاعدة البيانات', 404);
    }

    // 2. Defensive fallback calculation in case OpenAI API Key is absent, quota is exceeded, or API times out
    const defaultMin = project.budgetMin ?? project.budgetFixed ?? 3000;
    const defaultMax = project.budgetMax ?? project.budgetFixed ?? 6000;

    const generateFallbackResponse = (): AiProposalFeedback => {
      const isShort = !currentMessage || currentMessage.trim().length < 80;
      return {
        suggestedTitle: currentTitle && currentTitle.length > 5 
          ? `تطوير وتنفيذ: ${currentTitle.substring(0, 50)} باحترافية عالية` 
          : `تنفيذ مشروع ${project.title.substring(0, 50)} بأعلى معايير الجودة`,
        suggestedMessage: currentMessage && !isShort
          ? `${currentMessage}\n\nنضمن لكم الالتزام التام بكافة المتطلبات والمواصفات المحددة للمشروع مع تقديم أعلى معايير الأداء والجودة خلال ${project.deliveryDays} يوماً.`
          : `أهلاً بكم. بصفتي متخصصاً محترفاً في مجال (${project.specialty})، اطلعت بعناية على متطلباتكم لتنفيذ '${project.title}'. يسعدني تقديم هذا العرض المتكامل لتنفيذ المشروع بأعلى معايير الجودة وخلال المدة الزمنية المستهدفة (${project.deliveryDays} يوم) مع ضمان الدعم المستمر والتعديلات حتى الرضا التام.`,
        qualityScore: isShort ? 65 : 88,
        qualityTag: isShort ? 'MEDIUM' : 'GOOD',
        priceAudit: {
          recommendedMin: defaultMin,
          recommendedMax: defaultMax,
          priceTag: 'FAIR',
          justification: `الميزانية المستهدفة للمشروع تتوافق مع متوسط الأسعار لمعايير الجودة في تخصص ${project.specialty}.`
        },
        recommendedAdvantages: advantages && advantages.length >= 3 
          ? advantages 
          : [
              'الالتزام الصارم بجدولة التسليم وإنجاز المشروع في الوقت المحدد',
              'تقديم كود/مخرجات عالية الجودة وموثقة بالكامل وفق معايير القياس المهنية',
              'توفير استشارات فنية وتعديلات مجانية حتى الوصول לالرضا التام',
              'تسليم كامل ملفات المصدر (Source Files/Repositories) مع إرشادات التشغيل'
            ]
      };
    };

    // If OpenAI is unconfigured, return robust algorithmic fallback immediately
    if (!this.openai) {
      return generateFallbackResponse();
    }

    // 3. Construct System and User Prompts for OpenAI
    const systemPrompt = `You are an expert Senior Technical RFP Reviewer and AI Matchmaking Auditor for Waseet AI, a revolutionary cyber-creative B2B services marketplace in Saudi Arabia and the Middle East. 
Your role is to analyze a freelancer/provider's draft proposal against a project request and suggest high-converting, professional Arabic copy while evaluating the fair market price and quality score.
You MUST output strictly valid JSON conforming to the requested response schema with NO Markdown wrappers or extra commentary.`;

    const userPrompt = `
Analyze the following project parameters and the provider's proposal draft.

[Target Project Parameters]
- Title: ${project.title}
- Specialty: ${project.specialty}
- Description: ${project.description}
- Requirements: ${JSON.stringify(project.requirements)}
- Target Delivery Days: ${project.deliveryDays}
- Target Budget Range (SAR): ${defaultMin} - ${defaultMax}

[Provider's Current Proposal Draft]
- Title: ${currentTitle || '(Not provided yet)'}
- Message: ${currentMessage || '(Not provided yet)'}
- Listed Advantages: ${JSON.stringify(advantages)}

Generate a strict JSON response with this exact schema:
{
  "suggestedTitle": "Refined professional title in clear Arabic (max 80 chars)",
  "suggestedMessage": "Enhanced, persuasive Arabic proposal text (between 100-400 words) directly targeting project requirements",
  "qualityScore": Integer from 0 to 100 assessing completeness and professional rigor of current proposal draft (or suggested one if draft was empty),
  "qualityTag": one of "POOR", "MEDIUM", "GOOD", "EXCELLENT",
  "priceAudit": {
    "recommendedMin": number (suggested fair minimum price in SAR),
    "recommendedMax": number (suggested fair maximum price in SAR),
    "priceTag": one of "UNDERPRICED", "FAIR", "OVERPRICED",
    "justification": "Clear professional explanation in Arabic justifying why this price range is appropriate"
  },
  "recommendedAdvantages": ["Array of 3 to 5 strategic value propositions in Arabic that the provider should highlight"]
}
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 1500
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return generateFallbackResponse();
      }

      const parsed = JSON.parse(content) as AiProposalFeedback;
      return {
        suggestedTitle: parsed.suggestedTitle?.substring(0, 80) || generateFallbackResponse().suggestedTitle,
        suggestedMessage: parsed.suggestedMessage || generateFallbackResponse().suggestedMessage,
        qualityScore: typeof parsed.qualityScore === 'number' ? Math.min(Math.max(parsed.qualityScore, 0), 100) : 85,
        qualityTag: ['POOR', 'MEDIUM', 'GOOD', 'EXCELLENT'].includes(parsed.qualityTag) ? parsed.qualityTag : 'GOOD',
        priceAudit: parsed.priceAudit || generateFallbackResponse().priceAudit,
        recommendedAdvantages: Array.isArray(parsed.recommendedAdvantages) && parsed.recommendedAdvantages.length > 0
          ? parsed.recommendedAdvantages.slice(0, 5)
          : generateFallbackResponse().recommendedAdvantages
      };
    } catch (error) {
      console.error('[AiProposalService] OpenAI API execution failed or quota exceeded, returning graceful fallback:', error);
      return generateFallbackResponse();
    }
  }
}

export const aiProposalService = new AiProposalService();
export default aiProposalService;
