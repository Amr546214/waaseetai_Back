import { aiPromptRegistry } from '../prompt-registry';

export const PROPOSALS_PROMPT_VERSION = '2026-09-14.v1';

export const PROPOSALS_PROMPT_IDS = {
  proposalFeedback: 'proposals.proposal-feedback',
} as const;

export interface ProposalFeedbackProjectContext {
  title: string;
  description: string;
  specialty: string;
  requirements: string[];
  deliveryDays: number | null;
  defaultMinBudget: number;
  defaultMaxBudget: number;
}

export interface ProposalFeedbackPromptInput {
  project: ProposalFeedbackProjectContext;
  currentTitle?: string;
  currentMessage?: string;
  advantages: string[];
}

aiPromptRegistry.register<ProposalFeedbackPromptInput>({
  id: PROPOSALS_PROMPT_IDS.proposalFeedback,
  version: PROPOSALS_PROMPT_VERSION,
  capability: 'proposals',
  operation: 'proposal_feedback',
  defaultLocale: 'ar',
  supportedLocales: ['ar'],
  buildSystemPrompt: () =>
    `You are an expert Senior Technical RFP Reviewer and AI Matchmaking Auditor for Waseet AI, a B2B services marketplace in Saudi Arabia and the Middle East.
Your role is to analyze a freelancer/provider's draft proposal against a project request and suggest high-converting, professional Arabic copy while evaluating the fair market price and quality score.
You MUST output strictly valid JSON conforming to the requested response schema with NO Markdown wrappers or extra commentary.`,
  buildUserPrompt: input => `
Analyze the following project parameters and the provider's proposal draft.

[Target Project Parameters]
- Title: ${input.project.title}
- Specialty: ${input.project.specialty}
- Description: ${input.project.description}
- Requirements: ${JSON.stringify(input.project.requirements)}
- Target Delivery Days: ${input.project.deliveryDays}
- Target Budget Range (SAR): ${input.project.defaultMinBudget} - ${input.project.defaultMaxBudget}

[Provider's Current Proposal Draft]
- Title: ${input.currentTitle || '(Not provided yet)'}
- Message: ${input.currentMessage || '(Not provided yet)'}
- Listed Advantages: ${JSON.stringify(input.advantages)}

Generate a strict JSON response with this exact schema:
{
  "suggestedTitle": "Refined professional title in clear Arabic (max 80 chars)",
  "suggestedMessage": "Enhanced, persuasive Arabic proposal text directly targeting project requirements",
  "qualityScore": Integer from 0 to 100 assessing completeness and professional rigor of current proposal draft,
  "qualityTag": one of "POOR", "MEDIUM", "GOOD", "EXCELLENT",
  "priceAudit": {
    "recommendedMin": number (suggested fair minimum price in SAR),
    "recommendedMax": number (suggested fair maximum price in SAR),
    "priceTag": one of "UNDERPRICED", "FAIR", "OVERPRICED",
    "justification": "Clear professional explanation in Arabic justifying why this price range is appropriate"
  },
  "recommendedAdvantages": ["Array of 3 to 5 strategic value propositions in Arabic that the provider should highlight"]
}
`,
});
