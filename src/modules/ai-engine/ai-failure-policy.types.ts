export const AI_FAILURE_POLICIES = [
  'FAIL_CLOSED',
  'MANUAL_REVIEW',
  'OPTIONAL_AI',
  'STATIC_NON_AI_FALLBACK',
] as const;

export type AiFailurePolicy = typeof AI_FAILURE_POLICIES[number];

export type AiExecutionFallbackType =
  | 'MANUAL_REVIEW'
  | 'OPTIONAL_AI_SKIPPED'
  | 'STATIC_NON_AI_FALLBACK';

export const AI_FAILURE_POLICY_DESCRIPTIONS: Record<AiFailurePolicy, string> = {
  FAIL_CLOSED: 'AI is required. The operation cannot proceed without valid AI output.',
  MANUAL_REVIEW: 'AI failure produces no fabricated decision. The workflow must be routed to human review.',
  OPTIONAL_AI: 'The core business workflow may continue without AI enrichment.',
  STATIC_NON_AI_FALLBACK: 'A deterministic fallback is allowed only when explicitly labeled as non-AI.',
};

export const isAiFailurePolicy = (
  value: unknown
): value is AiFailurePolicy => {
  return AI_FAILURE_POLICIES.includes(value as AiFailurePolicy);
};
