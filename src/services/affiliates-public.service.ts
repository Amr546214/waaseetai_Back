import { UserStatus } from '@prisma/client';
import { prisma } from '../config/db';

// Public, PII-safe affiliate lookup — backs GET /api/affiliates/resolve and
// GET /api/affiliates/search (src/routes/affiliates-public.routes.ts), both
// unauthenticated (used during registration, before an account exists).
//
// This is the ONLY select this file ever uses against AffiliateProfile —
// deliberately never email/phone/bank/IBAN/KYC/wallet balance/commission
// rate or history/payout fields/the numeric `level` (its migration is not applied everywhere), regardless of what a caller
// asks for. Only ACTIVE affiliates are ever returned (a suspended/unverified account is invisible here).
const PUBLIC_AFFILIATE_SELECT = {
  id: true,
  referralSlug: true,
  firstName: true,
  lastName: true,
  currentLevel: true,
  identityVerified: true,
  avatarUrl: true
} as const;

/** Only affiliates whose user account is ACTIVE can be found, resolved or credited with a referral. */
const ACTIVE_AFFILIATE_ONLY = { user: { status: UserStatus.ACTIVE } } as const;

export interface PublicAffiliateResult {
  id: string;
  referralSlug: string | null;
  displayName: string;
  /** From AffiliateProfile.currentLevel (a label such as "مساعد"); never the numeric level. */
  levelName: string | null;
  /** AffiliateProfile.identityVerified. */
  verified: boolean;
  avatarUrl: string | null;
}

const MIN_SEARCH_QUERY_LENGTH = 2;
const SEARCH_RESULT_LIMIT = 10;

type PublicAffiliateRow = {
  id: string;
  referralSlug: string | null;
  firstName: string | null;
  lastName: string | null;
  currentLevel?: string | null;
  identityVerified?: boolean | null;
  avatarUrl?: string | null;
};

function toPublicShape(affiliate: PublicAffiliateRow): PublicAffiliateResult {
  const nameFromParts = `${affiliate.firstName || ''} ${affiliate.lastName || ''}`.trim();
  // Fallback chain when both name fields are null: the affiliate's own
  // referral slug (still not private), and only as a last resort a generic
  // Arabic label — never falls back to email/phone.
  const displayName = nameFromParts || affiliate.referralSlug || 'وسيط تسويقي';
  return {
    id: affiliate.id,
    referralSlug: affiliate.referralSlug,
    displayName,
    levelName: affiliate.currentLevel?.trim() || null,
    verified: affiliate.identityVerified === true,
    avatarUrl: affiliate.avatarUrl || null
  };
}

export class AffiliatesPublicService {
  /**
   * Resolves one ACTIVE affiliate by AffiliateProfile.referralSlug (case-insensitive) OR raw affiliate
   * `id`, per the existing convention established by
   * marketer-overview.service.ts::getRefLinks() — the same identifier used
   * for registration-time attribution (auth.service.ts's
   * resolveReferralAttribution()). Returns null (never throws) when not
   * found or not active — the controller maps that to a clean 404.
   */
  async resolveByCode(code: string): Promise<PublicAffiliateResult | null> {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const affiliate = await prisma.affiliateProfile.findFirst({
      where: {
        OR: [{ referralSlug: { equals: trimmed, mode: 'insensitive' } }, { id: trimmed }],
        ...ACTIVE_AFFILIATE_ONLY
      },
      select: PUBLIC_AFFILIATE_SELECT
    });
    return affiliate ? toPublicShape(affiliate) : null;
  }

  /**
   * Backs GET /api/affiliates/referral-status — tells the frontend (which
   * cannot read the httpOnly waseet_ref_code cookie itself) whether a valid
   * referral-cookie attribution currently exists, using only safe public
   * display data. `cookieSlug` is the raw waseet_ref_code cookie value (or
   * undefined when absent); reuses resolveByCode()'s exact lookup (by
   * referralSlug OR raw id, same PUBLIC_AFFILIATE_SELECT shape) rather than
   * duplicating the query. Never throws and never distinguishes "no cookie"
   * from "stale/invalid cookie" — both are just `{ active: false }`, so the
   * controller can always respond 200.
   */
  async getReferralStatus(cookieSlug: string | undefined): Promise<{ active: boolean; referralSlug?: string | null; displayName?: string }> {
    const trimmed = cookieSlug?.trim();
    if (!trimmed) return { active: false };

    const affiliate = await this.resolveByCode(trimmed);
    if (!affiliate) return { active: false };

    return { active: true, referralSlug: affiliate.referralSlug, displayName: affiliate.displayName };
  }

  /**
   * Case-insensitive search over ACTIVE affiliates by name (first/last) or referralSlug. Every whitespace-separated
   * word of the query must match the first name, last name or slug, so "amr okasha" finds "Amr Okasha". A full
   * slug match is listed first. An empty or too-short query returns an empty array, never an error — this backs a
   * live search-as-you-type autocomplete.
   */
  async search(query: string): Promise<PublicAffiliateResult[]> {
    const trimmed = (query || '').trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) return [];

    const exact = await prisma.affiliateProfile.findFirst({
      where: { referralSlug: { equals: trimmed, mode: 'insensitive' }, ...ACTIVE_AFFILIATE_ONLY },
      select: PUBLIC_AFFILIATE_SELECT
    });

    const words = trimmed.split(/\s+/).filter(Boolean);
    const others = await prisma.affiliateProfile.findMany({
      where: {
        AND: words.map(word => ({
          OR: [
            { firstName: { contains: word, mode: 'insensitive' } },
            { lastName: { contains: word, mode: 'insensitive' } },
            { referralSlug: { contains: word, mode: 'insensitive' } }
          ]
        })),
        ...ACTIVE_AFFILIATE_ONLY,
        ...(exact ? { id: { not: exact.id } } : {})
      },
      select: PUBLIC_AFFILIATE_SELECT,
      take: exact ? SEARCH_RESULT_LIMIT - 1 : SEARCH_RESULT_LIMIT
    });

    return [...(exact ? [exact] : []), ...others].map(toPublicShape);
  }
}

export const affiliatesPublicService = new AffiliatesPublicService();
