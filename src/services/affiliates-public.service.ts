import { prisma } from '../config/db';

// Public, PII-safe affiliate lookup — backs GET /api/affiliates/resolve and
// GET /api/affiliates/search (src/routes/affiliates-public.routes.ts), both
// unauthenticated (used during registration, before an account exists).
//
// This is the ONLY select this file ever uses against AffiliateProfile —
// deliberately never email/phone/bank/IBAN/KYC/wallet balance/commission
// history/any other private field, regardless of what a caller asks for.
const PUBLIC_AFFILIATE_SELECT = {
  id: true,
  referralSlug: true,
  firstName: true,
  lastName: true
} as const;

export interface PublicAffiliateResult {
  id: string;
  referralSlug: string | null;
  displayName: string;
}

const MIN_SEARCH_QUERY_LENGTH = 2;
const SEARCH_RESULT_LIMIT = 10;

function toPublicShape(affiliate: { id: string; referralSlug: string | null; firstName: string | null; lastName: string | null }): PublicAffiliateResult {
  const nameFromParts = `${affiliate.firstName || ''} ${affiliate.lastName || ''}`.trim();
  // Fallback chain when both name fields are null: the affiliate's own
  // referral slug (still not private), and only as a last resort a generic
  // Arabic label — never falls back to email/phone.
  const displayName = nameFromParts || affiliate.referralSlug || 'وسيط تسويقي';
  return { id: affiliate.id, referralSlug: affiliate.referralSlug, displayName };
}

export class AffiliatesPublicService {
  /**
   * Resolves one affiliate by AffiliateProfile.referralSlug OR raw affiliate
   * `id`, per the existing convention established by
   * marketer-overview.service.ts::getRefLinks() — the same identifier used
   * for registration-time attribution (auth.service.ts's
   * resolveReferralAttribution()). Returns null (never throws) when not
   * found — the controller maps that to a clean 404.
   */
  async resolveByCode(code: string): Promise<PublicAffiliateResult | null> {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const affiliate = await prisma.affiliateProfile.findFirst({
      where: { OR: [{ referralSlug: trimmed }, { id: trimmed }] },
      select: PUBLIC_AFFILIATE_SELECT
    });
    return affiliate ? toPublicShape(affiliate) : null;
  }

  /**
   * Case-insensitive partial match on firstName/lastName. An empty or
   * too-short query returns an empty array, never an error — this backs a
   * live search-as-you-type autocomplete.
   */
  async search(query: string): Promise<PublicAffiliateResult[]> {
    const trimmed = (query || '').trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) return [];

    const affiliates = await prisma.affiliateProfile.findMany({
      where: {
        OR: [
          { firstName: { contains: trimmed, mode: 'insensitive' } },
          { lastName: { contains: trimmed, mode: 'insensitive' } }
        ]
      },
      select: PUBLIC_AFFILIATE_SELECT,
      take: SEARCH_RESULT_LIMIT
    });
    return affiliates.map(toPublicShape);
  }
}

export const affiliatesPublicService = new AffiliatesPublicService();
