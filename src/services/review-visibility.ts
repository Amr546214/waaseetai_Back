/**
 * Review publication, in ONE place.
 *
 * A review carries `isPublic` (the reviewer's publish choice; existing rows are true). An UNPUBLISHED review (isPublic = false) stays readable by the two parties
 * (rating-status, project pages) and by the admin, but it must NEVER reach a public API (provider public profile, client public profile, marketplace cards / service
 * pages) and must NEVER enter a PUBLIC average, count or percentage.
 *
 * Two different numbers, deliberately separate:
 *  - PUBLIC rating (this file): reviews with isPublic = true only. Provider public profile, service rating, client public rating.
 *  - INTERNAL rating: every review, published or not. User.ratingAverage / ProviderGamification.avgRating (the level gate in progression-calculators.ts), the
 *    provider's own dashboard counters and the admin analytics keep counting everything, so a level never depends on the reviewer's publish choice.
 */
export const PUBLIC_REVIEW = { isPublic: true } as const;

/** Where-clause of the reviews a visitor may see for a provider: clients' reviews (project and stage), published only. */
export const publicProviderReviewsWhere = (providerId: string) => ({ providerId, reviewerRole: 'CLIENT', isPublic: true });

/** Where-clause of the published provider -> client reviews a visitor may see on a client's public profile. */
export const publicClientReviewsWhere = (clientId: string) => ({ clientId, reviewerRole: 'PROVIDER', isPublic: true });

/** Where-clause of the published client reviews of a service. */
export const publicServiceReviewsWhere = (serviceId: string) => ({ serviceId, reviewerRole: 'CLIENT', isPublic: true });

/** Relation filter for a ServiceCatalog -> reviews include/select: published client reviews only. */
export const PUBLIC_SERVICE_REVIEWS_RELATION = { where: { reviewerRole: 'CLIENT', isPublic: true } } as const;

/** Average (one decimal for display) of a list of already-public reviews; null when there are none (never a made-up 0). */
export function publicAverage(rows: Array<{ rating: number }>): number | null {
  if (!rows.length) return null;
  return rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
}
