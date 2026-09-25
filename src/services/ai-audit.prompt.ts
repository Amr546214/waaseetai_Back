export interface AiAuditReport {
  overallScore: number;
  clarityScore: number;
  feasibilityScore: number;
  isApproved: boolean;
  decisionSummary: string;
  strengths: string[];
  criticalGaps: string[];
  improvementSuggestions: string[];
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isScoreInRange = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

// Rejects anything that doesn't genuinely satisfy the audit contract — an
// out-of-range score, a missing decision summary, or a non-boolean
// isApproved are all invalid. Never silently patched with a placeholder
// score (the previous OpenAI path defaulted a missing/malformed score to 85
// and still marked the audit "completed" — a fabricated success this
// validator now prevents by surfacing as GeminiErrorCode.INVALID_RESPONSE,
// which routes to the existing honest manual-review default instead).
export function isValidAiAuditReport(value: unknown): value is AiAuditReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!isScoreInRange(v.overallScore)) return false;
  if (!isScoreInRange(v.clarityScore)) return false;
  if (!isScoreInRange(v.feasibilityScore)) return false;
  if (typeof v.isApproved !== 'boolean') return false;
  if (!isNonEmptyString(v.decisionSummary)) return false;
  if (!isStringArray(v.strengths)) return false;
  if (!isStringArray(v.criticalGaps)) return false;
  if (!isStringArray(v.improvementSuggestions)) return false;
  return true;
}

export const AI_AUDIT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    overallScore: { type: 'number' },
    clarityScore: { type: 'number' },
    feasibilityScore: { type: 'number' },
    isApproved: { type: 'boolean' },
    decisionSummary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    criticalGaps: { type: 'array', items: { type: 'string' } },
    improvementSuggestions: { type: 'array', items: { type: 'string' } }
  },
  required: ['overallScore', 'clarityScore', 'feasibilityScore', 'isApproved', 'decisionSummary', 'strengths', 'criticalGaps', 'improvementSuggestions']
};

export const AI_AUDITOR_PROMPT = `
You are Waseet AI's Chief Quality Control & Market Compliance Auditor.
Your task is to stringently analyze a newly submitted service model from a service provider before it enters the public marketplace.

Analyze the full payload:
1. Title & Description (Clarity, professionalism, clear deliverables)
2. Pricing vs Scope (Is the budget realistic for the described effort?)
3. Stages & Milestones (Are the durations in days logical? Do stage percentages equal 100%?)

Return ONLY a strict JSON object matching this structure:
{
  "overallScore": number (0 to 100),
  "clarityScore": number (0 to 100),
  "feasibilityScore": number (0 to 100),
  "isApproved": boolean, // MUST be true ONLY if overallScore >= 70 AND description is clear AND scope is feasible
  "decisionSummary": "string (Concise Arabic explanation of the audit decision)",
  "strengths": ["string (Arabic)"],
  "criticalGaps": ["string (Arabic)"],
  "improvementSuggestions": ["string (Arabic)"]
}

Strict Rules:
- Return ONLY clean valid JSON.
- Content must be in clear professional Arabic.
- Be rigorous. If a project description is gibberish, too vague, or pricing is completely unrealistic, set isApproved to false and overallScore below 70.
`;
