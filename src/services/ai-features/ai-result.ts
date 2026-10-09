// The ONE shape in which any AI-backed (or AI-labelled) result leaves the backend. A UI may show an AI label / icon / number only when
// status === 'READY' and source is WASEET_AI or GEMINI. Missing values are null — never 0, never a default, never a placeholder score.

export type AiSource = 'WASEET_AI' | 'GEMINI' | 'RULES' | 'NONE';
export type AiStatus = 'NOT_ENOUGH_DATA' | 'READY' | 'FAILED' | 'PENDING';

export interface AiResult<D = unknown> {
  status: AiStatus;
  source: AiSource;
  /** A real score from the vendor, or null. Never 0 as "missing". */
  score: number | null;
  /** Only when the vendor really returns one (or it can be justified); otherwise null. */
  confidence: number | null;
  summary: string | null;
  recommendation: string | null;
  details: D | null;
  /** ISO timestamp of when this result was produced; null when nothing was produced. */
  generatedAt: string | null;
}

const base = <D>(status: AiStatus, source: AiSource): AiResult<D> => ({ status, source, score: null, confidence: null, summary: null, recommendation: null, details: null, generatedAt: null });

export const aiNotEnoughData = <D = unknown>(): AiResult<D> => base<D>('NOT_ENOUGH_DATA', 'NONE');
export const aiPending = <D = unknown>(source: AiSource = 'NONE'): AiResult<D> => base<D>('PENDING', source);
export const aiFailed = <D = unknown>(source: AiSource = 'NONE', generatedAt: Date = new Date()): AiResult<D> => ({ ...base<D>('FAILED', source), generatedAt: generatedAt.toISOString() });

export function aiReady<D>(input: { source: Exclude<AiSource, 'NONE'>; score?: number | null; confidence?: number | null; summary?: string | null; recommendation?: string | null; details?: D | null; generatedAt?: Date | null }): AiResult<D> {
  const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  return {
    status: 'READY',
    source: input.source,
    score: finite(input.score),
    confidence: finite(input.confidence),
    summary: input.summary?.trim() ? input.summary.trim() : null,
    recommendation: input.recommendation?.trim() ? input.recommendation.trim() : null,
    details: input.details ?? null,
    generatedAt: input.generatedAt === null ? null : (input.generatedAt ?? new Date()).toISOString(),
  };
}

/** True when a UI may show the AI label / icon for this result. */
export const isRealAi = (r: Pick<AiResult, 'status' | 'source'> | null | undefined): boolean =>
  !!r && r.status === 'READY' && (r.source === 'WASEET_AI' || r.source === 'GEMINI');

/** Reads back a stored result (a JSON column) defensively: anything that is not a well-formed AiResult is dropped. */
export function parseStoredAiResult(value: unknown): AiResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const statuses: AiStatus[] = ['NOT_ENOUGH_DATA', 'READY', 'FAILED', 'PENDING'];
  const sources: AiSource[] = ['WASEET_AI', 'GEMINI', 'RULES', 'NONE'];
  if (!statuses.includes(v.status as AiStatus) || !sources.includes(v.source as AiSource)) return null;
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const str = (s: unknown) => (typeof s === 'string' && s.trim() ? s : null);
  return {
    status: v.status as AiStatus, source: v.source as AiSource, score: num(v.score), confidence: num(v.confidence),
    summary: str(v.summary), recommendation: str(v.recommendation), details: (v.details as unknown) ?? null, generatedAt: str(v.generatedAt),
  };
}
