export type AiScoreSemanticName =
  | 'modelConfidence'
  | 'matchScore'
  | 'qualityScore'
  | 'riskScore'
  | 'deterministicScore'
  | 'recommendationStrength';

export type AiScoreSource = 'MODEL' | 'DETERMINISTIC' | 'HYBRID';

export interface AiScoreRange {
  min: number;
  max: number;
}

export interface AiScoreSemanticDefinition {
  name: AiScoreSemanticName;
  source: AiScoreSource;
  range: AiScoreRange;
  higherIsBetter: boolean;
  description: string;
}

export interface AiSemanticScore {
  name: AiScoreSemanticName;
  value: number;
  source: AiScoreSource;
  range: AiScoreRange;
}

export const AI_SCORE_SEMANTIC_GUIDANCE: Record<
  AiScoreSemanticName,
  Omit<AiScoreSemanticDefinition, 'source'>
> = {
  modelConfidence: {
    name: 'modelConfidence',
    range: { min: 0, max: 1 },
    higherIsBetter: true,
    description: 'Model-reported uncertainty for a specific generated judgment, not proof of factual correctness.',
  },
  matchScore: {
    name: 'matchScore',
    range: { min: 0, max: 100 },
    higherIsBetter: true,
    description: 'Compatibility score between two known entities under a capability-specific rubric.',
  },
  qualityScore: {
    name: 'qualityScore',
    range: { min: 0, max: 100 },
    higherIsBetter: true,
    description: 'Capability-defined quality assessment for a specific artifact or response.',
  },
  riskScore: {
    name: 'riskScore',
    range: { min: 0, max: 100 },
    higherIsBetter: false,
    description: 'Risk indicator where higher values represent greater concern or required review.',
  },
  deterministicScore: {
    name: 'deterministicScore',
    range: { min: 0, max: 100 },
    higherIsBetter: true,
    description: 'Score produced by deterministic code or business rules without model judgment.',
  },
  recommendationStrength: {
    name: 'recommendationStrength',
    range: { min: 0, max: 1 },
    higherIsBetter: true,
    description: 'Strength of a generated recommendation under a capability-specific decision rubric.',
  },
};
