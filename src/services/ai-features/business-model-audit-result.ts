import { aiNotEnoughData, aiPending, aiReady, type AiResult } from './ai-result';

// The stored WaseetAI audit of a business model (ServiceCatalog.aiAuditReport / aiAuditScore) as an AiResult. Nothing is derived or invented:
// no sub-metrics from one score, no default 0. READY only when the audit really ran and stored a score; otherwise PENDING (not audited yet).

export interface BusinessModelAuditDetails { isApproved: boolean | null; strengths: string[]; issues: string[]; recommendations: string[] }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 12) : []);

export function businessModelAuditResult(model: { aiAuditScore?: number | null; aiAuditReport?: unknown }): AiResult<BusinessModelAuditDetails> {
  const report = model.aiAuditReport && typeof model.aiAuditReport === 'object' && !Array.isArray(model.aiAuditReport) ? (model.aiAuditReport as Record<string, unknown>) : null;
  const score = typeof model.aiAuditScore === 'number' && Number.isFinite(model.aiAuditScore) ? model.aiAuditScore : (report && typeof report.score === 'number' && Number.isFinite(report.score) ? report.score : null);
  if (score === null || !report || report.source !== 'WASEET_AI') return model.aiAuditScore == null && !report ? aiPending() : aiNotEnoughData();
  return aiReady<BusinessModelAuditDetails>({
    source: 'WASEET_AI', score, confidence: null,
    summary: typeof report.summary === 'string' ? report.summary : null,
    recommendation: strings(report.recommendations)[0] ?? null,
    details: { isApproved: typeof report.isApproved === 'boolean' ? report.isApproved : null, strengths: strings(report.strengths), issues: strings(report.issues), recommendations: strings(report.recommendations) },
    generatedAt: null, // the audit stores no timestamp: never invent one
  });
}
