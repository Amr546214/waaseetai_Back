import { z } from 'zod';
import { logger } from '../../config/logger';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, inputsUsed } from './ai-feature.shared';
import { aiFailed, aiNotEnoughData, aiReady, type AiResult } from './ai-result';

// The shared engine of every "AI summary over real metrics" feature (client reports, marketer insights, admin forecast / anomaly /
// sentiment cards). A feature supplies REAL aggregated metrics + an allowlist; this module decides:
//   - too little real data  -> NOT_ENOUGH_DATA (the model is never called, nothing is invented);
//   - the model is missing / fails / returns ungrounded output -> FAILED (the caller's page keeps working);
//   - otherwise READY with a summary, observations and recommendations that each cite fields that were really sent (basedOn).
// No score, no confidence, no default values: those stay null.

export const MetricSummarySchema = z.object({
  summary: z.string().min(1).max(600),
  observations: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).max(6),
  recommendations: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).max(4),
});
export type MetricSummaryOutput = z.infer<typeof MetricSummarySchema>;
export interface MetricSummaryDetails { observations: { text: string; basedOn: string[] }[]; recommendations: { text: string; basedOn: string[] }[] }

export interface MetricSummaryInput {
  /** LlmClient feature name (rate limit / budget / logs are per feature). */
  feature: string;
  userId: string;
  /** Real aggregated metrics; only fields named in `allow` ever leave the server. */
  metrics: unknown;
  allow: AllowRule;
  /** Payload paths that must carry data: the "enough data" test. */
  paths: string[];
  /** At least this many of `paths` must hold real values, else NOT_ENOUGH_DATA. */
  minUsedPaths: number;
  /** Task-specific instructions (Arabic). The grounding rules are appended automatically. */
  system: string;
  /** Optional extra check that the metrics themselves are meaningful (e.g. >= N records). */
  hasEnoughData?: (payload: any) => boolean;
}

export type MetricSummaryResult = AiResult<MetricSummaryDetails>;

export class MetricSummaryEngine {
  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient) {}

  async summarise(input: MetricSummaryInput): Promise<MetricSummaryResult> {
    const payload = buildPayload(input.metrics, input.allow) as any;
    const used = inputsUsed(payload, input.paths);
    if (used.length < input.minUsedPaths || (input.hasEnoughData && !input.hasEnoughData(payload))) return aiNotEnoughData<MetricSummaryDetails>();
    try {
      const res = await this.llm.generateJson<MetricSummaryOutput>({
        feature: input.feature, userId: input.userId, schema: MetricSummarySchema, system: `${input.system}\n${GROUNDING_RULES_AR}`, input: payload,
        timeoutMs: 25_000, maxOutputTokens: 1100, cache: true,
        grounding: { basedOn: ['observations[].basedOn', 'recommendations[].basedOn'], freeText: ['summary', 'observations[].text', 'recommendations[].text'], allowedNumbers: [0, 100] },
      });
      return aiReady<MetricSummaryDetails>({
        source: 'GEMINI', score: null, confidence: null, summary: res.data.summary, recommendation: null,
        details: { observations: res.data.observations, recommendations: res.data.recommendations },
      });
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'ERROR';
      logger.warn(`[MetricSummary:${input.feature}] unavailable (${code}); the page keeps working without it`);
      return { ...aiFailed<MetricSummaryDetails>('GEMINI'), details: null } as MetricSummaryResult;
    }
  }
}

export const metricSummaryEngine = new MetricSummaryEngine();
