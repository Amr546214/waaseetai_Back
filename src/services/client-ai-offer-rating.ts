// "تقييم AI للعروض" on the client dashboard: the average of the REAL WaseetAI proposal evaluations stored on the offers the client received
// (Proposal.aiMatchScore = WaseetAI qualityScore of the submitted proposal, blended with budget closeness in proposal.service.ts; null when the AI was
// unavailable at submission). Shown as stars out of 5 (score / 20). Nothing is invented: no scored offer -> aiRating null.
// aiConfidence is null on purpose: WaseetAI reports no accuracy/confidence for these scores, so none is claimed.

export interface ClientAiOfferRating {
  aiRating: number | null;
  aiConfidence: null;
  aiRatingSource: 'waseet_ai_offer_quality' | 'none';
  aiRatingUpdatedAt: string | null;
  aiRatedOffersCount: number;
}

export function computeClientAiOfferRating(rows: Array<{ aiMatchScore: number | null; createdAt: Date | string }>): ClientAiOfferRating {
  const scored = rows.filter(r => typeof r.aiMatchScore === 'number' && Number.isFinite(r.aiMatchScore) && r.aiMatchScore >= 0 && r.aiMatchScore <= 100);
  if (scored.length === 0) {
    return { aiRating: null, aiConfidence: null, aiRatingSource: 'none', aiRatingUpdatedAt: null, aiRatedOffersCount: 0 };
  }
  const avg = scored.reduce((s, r) => s + (r.aiMatchScore as number), 0) / scored.length;
  const latest = Math.max(...scored.map(r => new Date(r.createdAt).getTime()));
  return {
    aiRating: Math.round((avg / 20) * 10) / 10,
    aiConfidence: null,
    aiRatingSource: 'waseet_ai_offer_quality',
    aiRatingUpdatedAt: new Date(latest).toISOString(),
    aiRatedOffersCount: scored.length,
  };
}
