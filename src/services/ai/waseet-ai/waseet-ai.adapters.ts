// Pure request/response adapters between Waseet's existing feature contracts
// (what Angular already sends/receives) and the documented WaseetAI v1.0.0
// contracts (WaseetAI_API_Integration_Guide.pdf, sections 2.1–2.3).
//
//   Angular ──▶ existing /api/... endpoint (unchanged shape)
//           ──▶ build*Request (this file) ──▶ waseetAiClient ──▶ WaseetAI
//           ◀── map*Response  (this file) ◀── documented response
//
// Rules enforced here:
//  - Only fields the guide documents are sent or read. Nothing is guessed.
//  - Required upstream inputs that Waseet does not have are NOT invented:
//    the build functions return null and the caller reports a 400.
//  - A response that does not satisfy the documented contract is rejected
//    as INVALID_RESPONSE — never patched into a plausible-looking result.
//  - Waseet fields WaseetAI does not provide are returned empty/null, never
//    synthesized (see mapProjectAnalysisResponse).
//  - AI scores are passed through exactly as returned: no clamping,
//    rescaling, rounding or "nicer" ranges. Out-of-range = invalid.

import { WaseetAiError, WaseetAiErrorCode } from './waseet-ai.errors';
import type {
  MilestonesRequest,
  ProjectAnalysisRequest,
  ProjectDescriptionStreamRequest,
} from './waseet-ai.types';
import type { AiReviewResponse, CompleteProjectDataDto, MilestoneDto, SuggestedMilestone } from '../../../modules/ai-review/ai-review.dto';

/** The provider "New Project" wizard (step 4) prices every service in US
 *  dollars ("حدد القيمة الإجمالية بالدولار الأمريكي", `$`), so that is the
 *  currency sent for its totalAmount/budget. */
export const PROVIDER_SERVICE_CURRENCY = 'USD';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function invalid(detail: string): WaseetAiError {
  // `detail` is our own fixed text describing which check failed — never
  // upstream content.
  return new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, `WaseetAI response failed adapter validation: ${detail}`);
}

// ── AI-01 — POST /v1/ai/project-description/stream ─────────────────────────

/**
 * Documented body: { title, category, language, modelTier? }. Waseet's
 * socket payload carries a main specialty plus optional sub-specialties;
 * the guide has a single free-text `category` (example: "Web & Mobile
 * Development"), so the selected sub-specialties are appended to it as
 * context. `modelTier` is optional and left to WaseetAI's own routing.
 */
export function buildProjectDescriptionRequest(input: { title: string; specialty: string; subSpecialties: string[] }): ProjectDescriptionStreamRequest {
  const subs = input.subSpecialties.filter(nonEmptyString);
  const category = subs.length > 0 ? `${input.specialty} — ${subs.join('، ')}` : input.specialty;
  return { title: input.title, category, language: 'ar' };
}

// ── AI-03 — POST /v1/ai/milestones ─────────────────────────────────────────

/** Returns null when a documented required input is missing — `totalAmount`
 *  is required by the guide and is never defaulted. */
export function buildMilestonesRequest(input: { title?: string; description?: string; totalAmount?: unknown }): MilestonesRequest | null {
  const title = (input.title ?? '').trim();
  const totalAmount = typeof input.totalAmount === 'string' ? Number(input.totalAmount) : input.totalAmount;
  if (!title || !isFiniteNumber(totalAmount) || totalAmount <= 0) return null;
  return { title, description: (input.description ?? '').trim(), totalAmount, currency: PROVIDER_SERVICE_CURRENCY };
}

/**
 * Documented response: { milestones: [{ title, description, days,
 * percentage, amount }] }. Mapped to Waseet's existing SuggestedMilestone
 * ({ title, description, estimatedDays, percentage }). `amount` is
 * intentionally dropped — the wizard derives amounts from percentage ×
 * its own totalAmount, which keeps the money figures consistent with the
 * user's current budget.
 *
 * The pre-existing exact-100% business rule is preserved: if the
 * percentages do not sum to 100 the difference is applied to the last
 * milestone; if that would push it outside 0..100 the response is invalid
 * (it is never silently rebalanced into something WaseetAI didn't say).
 */
export function mapMilestonesResponse(data: unknown): SuggestedMilestone[] {
  if (!isObject(data) || !Array.isArray(data.milestones) || data.milestones.length === 0) {
    throw invalid('milestones must be a non-empty array');
  }
  const milestones: SuggestedMilestone[] = data.milestones.map((m: unknown, i: number) => {
    if (!isObject(m)) throw invalid(`milestone ${i} is not an object`);
    if (!nonEmptyString(m.title)) throw invalid(`milestone ${i} title missing`);
    if (typeof m.description !== 'string') throw invalid(`milestone ${i} description missing`);
    if (!isFiniteNumber(m.days) || m.days <= 0) throw invalid(`milestone ${i} days missing or not positive`);
    if (!isFiniteNumber(m.percentage) || m.percentage < 0 || m.percentage > 100) throw invalid(`milestone ${i} percentage missing or out of range`);
    return { title: m.title.trim(), description: m.description.trim(), estimatedDays: m.days, percentage: m.percentage };
  });

  const total = milestones.reduce((sum, m) => sum + (m.percentage ?? 0), 0);
  if (total !== 100) {
    const last = milestones[milestones.length - 1];
    const corrected = (last.percentage ?? 0) + (100 - total);
    if (corrected < 0 || corrected > 100) throw invalid('percentages cannot be balanced to 100');
    last.percentage = corrected;
  }
  return milestones;
}

// ── AI-04 — POST /v1/ai/project-analysis ───────────────────────────────────

function stageDays(stage: MilestoneDto): number {
  const raw = stage.days ?? stage.estimatedDays;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return isFiniteNumber(n) && n > 0 ? n : 0;
}

/**
 * Documented body: { title, description, budget, deadlineDays, currency }.
 *  - budget       ← the wizard's totalAmount
 *  - deadlineDays ← the sum of the provider's own stage durations (the only
 *                   timeline Waseet has for a service model)
 * Returns null when budget or a positive timeline is missing — neither is
 * ever defaulted. category/specialty/modelType/stage titles have no field in
 * the documented contract and are not sent.
 */
export function buildProjectAnalysisRequest(dto: CompleteProjectDataDto): ProjectAnalysisRequest | null {
  const title = (dto.title ?? '').trim();
  const budget = typeof dto.totalAmount === 'string' ? Number(dto.totalAmount) : dto.totalAmount;
  const stages = Array.isArray(dto.stages) && dto.stages.length > 0 ? dto.stages : Array.isArray(dto.milestones) ? dto.milestones : [];
  const deadlineDays = stages.reduce((sum, s) => sum + stageDays(s ?? {}), 0);
  if (!title || !isFiniteNumber(budget) || budget <= 0 || deadlineDays <= 0) return null;
  return { title, description: (dto.description ?? '').trim(), budget, deadlineDays, currency: PROVIDER_SERVICE_CURRENCY };
}

const MARKET_FIT_VALUES = ['High', 'Medium', 'Low'] as const;

/** Only an exact (case-insensitive) High/Medium/Low is accepted. The guide's
 *  sample value is "Good", whose position on Waseet's 3-level scale is not
 *  documented — so it (and anything else) maps to null instead of a guess. */
export function normalizeMarketFitRating(raw: unknown): AiReviewResponse['marketFitRating'] {
  if (typeof raw !== 'string') return null;
  const match = MARKET_FIT_VALUES.find((v) => v.toLowerCase() === raw.trim().toLowerCase());
  return match ?? null;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  return value.filter(nonEmptyString).map((s) => s.trim());
}

function score(value: unknown, field: string): number {
  if (!isFiniteNumber(value) || value < 0 || value > 100) throw invalid(`${field} missing or outside 0..100`);
  return value;
}

/**
 * Documented response: { clarityScore, feasibilityScore, marketFitRating,
 * executiveSummary, strengths[], gapsAndRisks[] }.
 *
 * Waseet's AiReviewResponse also has recommendedImprovements,
 * suggestedMilestones and suggestedPricingStrategy, which project-analysis
 * does NOT return:
 *  - recommendedImprovements  → []   (no WaseetAI equivalent)
 *  - suggestedPricingStrategy → null (no WaseetAI equivalent)
 *  - suggestedMilestones      → the real result of the separate documented
 *                               /v1/ai/milestones call when the caller has
 *                               one, otherwise [] — never synthesized.
 */
export function mapProjectAnalysisResponse(data: unknown, milestones: SuggestedMilestone[] | null): AiReviewResponse {
  if (!isObject(data)) throw invalid('analysis payload is not an object');
  if (!nonEmptyString(data.executiveSummary)) throw invalid('executiveSummary missing');
  return {
    clarityScore: score(data.clarityScore, 'clarityScore'),
    feasibilityScore: score(data.feasibilityScore, 'feasibilityScore'),
    marketFitRating: normalizeMarketFitRating(data.marketFitRating),
    executiveSummary: data.executiveSummary.trim(),
    strengths: stringList(data.strengths, 'strengths'),
    gapsAndRisks: stringList(data.gapsAndRisks, 'gapsAndRisks'),
    recommendedImprovements: [],
    suggestedMilestones: milestones ?? [],
    suggestedPricingStrategy: null,
  };
}
