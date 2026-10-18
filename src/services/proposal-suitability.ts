import { z } from 'zod';

const point = z.object({ text: z.string().min(1).max(300), basedOn: z.array(z.string().min(1).max(120)).min(1).max(6) });
const storedFitSchema = z.object({
  source: z.literal('LLM'), overallFit: z.enum(['HIGH', 'MEDIUM', 'LOW']), summary: z.string().min(1).max(700),
  matchPoints: z.array(point).max(6), gaps: z.array(point).max(6),
});
export type StoredProviderFit = z.infer<typeof storedFitSchema>;

/** Only trusted stored review fields, never the raw feedback JSON. Legacy blended scores are not relabelled as pure quality. */
export function readProposalReview(feedback: unknown) {
  const value = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback as Record<string, unknown> : {};
  const score = value.source === 'WASEET_AI' && typeof value.qualityScore === 'number' && Number.isFinite(value.qualityScore) && value.qualityScore >= 0 && value.qualityScore <= 100 ? value.qualityScore : null;
  const parsed = storedFitSchema.safeParse(value.providerFit);
  return { qualityScore: score, providerFit: parsed.success ? parsed.data : null };
}

const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
export function proposalBudgetSuitability(price: unknown, min: unknown, max: unknown, budgetType?: unknown) {
  const amount = positive(price), lower = positive(min), upper = positive(max) ?? (String(budgetType).toUpperCase() === 'FIXED' ? lower : null);
  if (amount === null || (lower === null && upper === null) || (lower !== null && upper !== null && lower > upper)) return { status: 'UNKNOWN' as const, summary: 'بيانات الميزانية غير كافية للمقارنة.' };
  if (lower !== null && amount < lower) return { status: 'BELOW_RANGE' as const, summary: 'سعر العرض أقل من الحد المذكور؛ راجع شمول المتطلبات. انخفاض السعر وحده لا يقلل التوصية.' };
  if (upper !== null && amount > upper) return { status: 'ABOVE_RANGE' as const, summary: 'سعر العرض يتجاوز ميزانية الطلب؛ يحتاج اتفاقًا معك.' };
  return { status: 'WITHIN_RANGE' as const, summary: 'سعر العرض يوافق حدود الميزانية المسجلة. هذه مقارنة بالطلب وليست تقديرًا لسعر السوق.' };
}

export function proposalDeadlineSuitability(days: unknown, expectedDays: unknown) {
  const offered = positive(days), expected = positive(expectedDays);
  if (offered === null || expected === null) return { status: 'UNKNOWN' as const, summary: 'المدة المطلوبة أو مدة العرض غير متوفرة للمقارنة.' };
  return offered <= expected
    ? { status: 'WITHIN_DEADLINE' as const, summary: 'مدة العرض ضمن المدة المطلوبة؛ هذا التزام المقدم وليس ضمانًا للتنفيذ.' }
    : { status: 'EXCEEDS_DEADLINE' as const, summary: 'مدة العرض أطول من المدة المطلوبة؛ راجع الموعد مع المقدم.' };
}

type ComparableOffer = {
  id: string; status: string; aiProviderFit: StoredProviderFit | null; aiQualityScore: number | null;
  budgetSuitability: ReturnType<typeof proposalBudgetSuitability>;
  deadlineSuitability: ReturnType<typeof proposalDeadlineSuitability>;
};
const fitPriority = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const liveStatuses = new Set(['PENDING', 'SUBMITTED', 'IN_AI_REVIEW', 'UNDER_NEGOTIATION']);

/** Advisory ordinal ranks only: no fabricated compatibility %, unknown reviews remain unranked, ties share a rank. */
export function proposalRecommendationRanks(offers: ComparableOffer[]): Map<string, number> {
  const compare = (a: ComparableOffer, b: ComparableOffer) => {
    const fit = fitPriority[a.aiProviderFit!.overallFit] - fitPriority[b.aiProviderFit!.overallFit];
    if (fit) return fit;
    // Unknown constraints are visibly unresolved, never a fabricated zero
    // score. Confirmed compatible terms lead unresolved terms, then known conflicts.
    const deadlinePriority = { WITHIN_DEADLINE: 0, UNKNOWN: 1, EXCEEDS_DEADLINE: 2 };
    const deadline = deadlinePriority[a.deadlineSuitability.status] - deadlinePriority[b.deadlineSuitability.status];
    if (deadline) return deadline;
    const budgetPriority = { WITHIN_RANGE: 0, BELOW_RANGE: 0, UNKNOWN: 1, ABOVE_RANGE: 2 };
    const budget = budgetPriority[a.budgetSuitability.status] - budgetPriority[b.budgetSuitability.status];
    if (budget) return budget;
    if (a.aiQualityScore === null || b.aiQualityScore === null) return a.aiQualityScore === b.aiQualityScore ? 0 : a.aiQualityScore === null ? 1 : -1;
    return b.aiQualityScore - a.aiQualityScore;
  };
  const reviewed = offers.filter(offer => offer.aiProviderFit && liveStatuses.has(offer.status)).sort(compare);
  const result = new Map<string, number>();
  let rank = 1;
  reviewed.forEach((offer, index) => {
    if (index > 0 && compare(reviewed[index - 1], offer) !== 0) rank = index + 1;
    result.set(offer.id, rank);
  });
  return result;
}
