import type { CompleteProjectDataDto } from '../../ai-review/ai-review.dto';
import { SYSTEM_PROMPT } from '../../ai-review/ai-analyzer.prompt';
import { aiPromptRegistry } from '../prompt-registry';

export const PROJECT_INTELLIGENCE_PROMPT_VERSION = '2026-09-14.v1';

export const PROJECT_INTELLIGENCE_PROMPT_IDS = {
  suggestMilestones: 'project-intelligence.suggest-milestones',
  analyzeProjectModel: 'project-intelligence.analyze-project-model',
  clientRequestSuggestions: 'project-intelligence.client-request-suggestions',
} as const;

export interface SuggestMilestonesPromptInput {
  title?: string;
  description?: string;
  totalAmount?: number;
}

export interface ClientRequestSuggestionsPromptInput {
  draftTitle: string;
  draftDescription: string;
  targetSpecialty: string;
  selectedSubSpecialties: string[];
  favoriteCategory: string | null;
}

aiPromptRegistry.register<SuggestMilestonesPromptInput>({
  id: PROJECT_INTELLIGENCE_PROMPT_IDS.suggestMilestones,
  version: PROJECT_INTELLIGENCE_PROMPT_VERSION,
  capability: 'project_intelligence',
  operation: 'suggest_milestones',
  defaultLocale: 'ar',
  supportedLocales: ['ar'],
  buildSystemPrompt: () =>
    'You are Waseet AI Project Manager and Financial Strategist. Given the project title and description, generate a realistic, structured list of 3 to 4 sequential milestones for this project in professional Arabic. Each milestone must have: "title" (string), "description" (string deliverables explanation), "estimatedDays" (integer between 2 and 15), and "percentage" (number percentage of total payment). The sum of all "percentage" values MUST equal 100 within a tolerance of 1 percentage point. Return strictly a JSON object with a single root key "milestones" containing an array of these milestone objects.',
  buildUserPrompt: input => {
    const title = input.title || 'New project';
    const description = input.description || '';
    return `Project Title: "${title}"\nProject Description: "${description}"\nGenerate optimal operational milestones and payment percentages.`;
  },
});

aiPromptRegistry.register<CompleteProjectDataDto>({
  id: PROJECT_INTELLIGENCE_PROMPT_IDS.analyzeProjectModel,
  version: PROJECT_INTELLIGENCE_PROMPT_VERSION,
  capability: 'project_intelligence',
  operation: 'analyze_project_model',
  defaultLocale: 'ar',
  supportedLocales: ['ar'],
  buildSystemPrompt: () => SYSTEM_PROMPT,
  buildUserPrompt: input =>
    `Please evaluate this proposed project business model:\n${JSON.stringify(input, null, 2)}`,
});

aiPromptRegistry.register<ClientRequestSuggestionsPromptInput>({
  id: PROJECT_INTELLIGENCE_PROMPT_IDS.clientRequestSuggestions,
  version: PROJECT_INTELLIGENCE_PROMPT_VERSION,
  capability: 'project_intelligence',
  operation: 'client_request_suggestions',
  defaultLocale: 'ar',
  supportedLocales: ['ar'],
  buildSystemPrompt: () =>
    `You are Waseet AI, the ultimate AI Matchmaker for top technical and creative projects in Saudi Arabia.
Your job is to analyze the client's draft project request, refine the Arabic text into a high-precision RFP, suggest optimal sub-specialties, estimate SAR budget ranges, and calculate an AI match readiness score.
Return ONLY raw JSON with no Markdown wrapping.`,
  buildUserPrompt: input => `
Analyze this Client Request Draft:
- Draft Title: ${input.draftTitle || 'Unspecified'}
- Draft Description: ${input.draftDescription || 'Unspecified'}
- Target Specialty: ${input.targetSpecialty}
- Selected Sub-Specialties: ${JSON.stringify(input.selectedSubSpecialties || [])}
- Client Past History Specialty Context: ${input.favoriteCategory || 'New Client'}

Return JSON schema:
{
  "suggestedTitle": "Professional Arabic Title (max 120 chars)",
  "suggestedDescription": "Comprehensive Arabic Technical Description with clear scope and expectations",
  "suggestedSubSpecialties": ["3 to 5 relevant Arabic sub-specialty tags"],
  "recommendedMinBudget": number (SAR minimum),
  "recommendedMaxBudget": number (SAR maximum),
  "suggestedDurationDays": number (days),
  "complexityRating": "LOW" | "MEDIUM" | "HIGH" | "COMPLEX",
  "personalizedNote": "Arabic advice personalized for client request based on market standards",
  "aiMatchScoreEstimate": number between 0 and 100
}
`,
});
