import { prisma } from '../utils/prisma.client';
import { AppError } from '../utils/app-error';
import { geminiClient } from './ai/gemini/gemini.client';

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
  // Canonical application field name — the frontend has always read
  // `suggestedAdvantages`; the backend previously sent `recommendedAdvantages`,
  // a live contract mismatch that made this field permanently empty on the
  // client. Fixed by standardizing on the name the frontend already expects.
  suggestedAdvantages: string[];
}

const PRICE_TAGS = ['UNDERPRICED', 'FAIR', 'OVERPRICED'] as const;
const QUALITY_TAGS = ['POOR', 'MEDIUM', 'GOOD', 'EXCELLENT'] as const;

const AI_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    suggestedTitle: { type: 'string', description: 'Refined professional title in clear Arabic (max 80 chars)' },
    suggestedMessage: { type: 'string', description: 'Enhanced, persuasive Arabic proposal text (100-400 words) directly targeting project requirements' },
    qualityScore: { type: 'number', description: 'Integer from 0 to 100 assessing completeness and professional rigor of the current proposal draft' },
    qualityTag: { type: 'string', enum: [...QUALITY_TAGS] },
    priceAudit: {
      type: 'object',
      properties: {
        recommendedMin: { type: 'number' },
        recommendedMax: { type: 'number' },
        priceTag: { type: 'string', enum: [...PRICE_TAGS] },
        justification: { type: 'string' }
      },
      required: ['recommendedMin', 'recommendedMax', 'priceTag', 'justification']
    },
    suggestedAdvantages: {
      type: 'array',
      items: { type: 'string' },
      description: 'Array of 3 to 5 strategic value propositions in Arabic that the provider should highlight'
    }
  },
  required: ['suggestedTitle', 'suggestedMessage', 'qualityScore', 'qualityTag', 'priceAudit', 'suggestedAdvantages']
};

// Rejects any Gemini output that doesn't genuinely satisfy the application
// contract — wrong types, an out-of-range score, an unrecognized enum value,
// or an empty advantages list are all treated as invalid, never silently
// patched with fabricated data.
function isValidProposalFeedback(value: unknown): value is AiProposalFeedback {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;

  if (typeof v.suggestedTitle !== 'string' || v.suggestedTitle.trim().length === 0) return false;
  if (typeof v.suggestedMessage !== 'string' || v.suggestedMessage.trim().length === 0) return false;
  if (typeof v.qualityScore !== 'number' || !Number.isFinite(v.qualityScore) || v.qualityScore < 0 || v.qualityScore > 100) return false;
  if (typeof v.qualityTag !== 'string' || !(QUALITY_TAGS as readonly string[]).includes(v.qualityTag)) return false;

  const priceAudit = v.priceAudit as Record<string, unknown> | undefined;
  if (!priceAudit || typeof priceAudit !== 'object') return false;
  if (typeof priceAudit.recommendedMin !== 'number' || !Number.isFinite(priceAudit.recommendedMin)) return false;
  if (typeof priceAudit.recommendedMax !== 'number' || !Number.isFinite(priceAudit.recommendedMax)) return false;
  if (typeof priceAudit.priceTag !== 'string' || !(PRICE_TAGS as readonly string[]).includes(priceAudit.priceTag)) return false;
  if (typeof priceAudit.justification !== 'string' || priceAudit.justification.trim().length === 0) return false;

  if (!Array.isArray(v.suggestedAdvantages) || v.suggestedAdvantages.length === 0) return false;
  if (!v.suggestedAdvantages.every((a) => typeof a === 'string' && a.trim().length > 0)) return false;

  return true;
}

class AiProposalService {
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

    const defaultMin = project.budgetMin ?? project.budgetFixed ?? 3000;
    const defaultMax = project.budgetMax ?? project.budgetFixed ?? 6000;

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
- Target Budget Range (USD): ${defaultMin} - ${defaultMax}

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
    "recommendedMin": number (suggested fair minimum price in USD),
    "recommendedMax": number (suggested fair maximum price in USD),
    "priceTag": one of "UNDERPRICED", "FAIR", "OVERPRICED",
    "justification": "Clear professional explanation in Arabic justifying why this price range is appropriate"
  },
  "suggestedAdvantages": ["Array of 3 to 5 strategic value propositions in Arabic that the provider should highlight"]
}
`;

    try {
      const result = await geminiClient.generateStructured<AiProposalFeedback>(userPrompt, {
        systemInstruction: systemPrompt,
        responseSchema: AI_PROPOSAL_SCHEMA,
        validate: isValidProposalFeedback,
        temperature: 0.7,
        maxOutputTokens: 1500
      });

      return {
        ...result.data,
        suggestedTitle: result.data.suggestedTitle.substring(0, 80),
        suggestedAdvantages: result.data.suggestedAdvantages.slice(0, 5)
      };
    } catch (error) {
      // Honest failure — no fabricated titles, messages, scores, or
      // advantages. The caller receives a normal application error instead
      // of a fake "successful" suggestion.
      throw new AppError('تعذر إنشاء اقتراحات الذكاء الاصطناعي للعرض حالياً، يرجى المحاولة لاحقاً.', 503);
    }
  }
}

export const aiProposalService = new AiProposalService();
export default aiProposalService;
