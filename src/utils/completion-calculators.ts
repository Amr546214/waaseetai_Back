// Phase 3D.2A: pure, side-effect-free profile-completion calculators.
// No Prisma imports, no dotenv, no DB, no service imports with side effects —
// each function takes already-fetched plain data and returns a number, so
// these can be unit-tested without ever loading db.ts.
//
// One calculator per role, not one shared formula — each preserves its own
// pre-existing field list and weights exactly (see the docstring on each
// function for provenance).

export interface ClientCompletionInput {
  /** Identity-level User fields the historical formula reads. */
  user: {
    firstName?: string | null;
    lastName?: string | null;
    phoneNumber?: string | null;
    avatarUrl?: string | null;
    idNumber?: string | null;
    idExpiryDate?: unknown;
    ibanNumber?: string | null;
    bankName?: string | null;
    accountHolderName?: string | null;
  };
  clientProfile: {
    paypalPayoutEmail?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    companyName?: string | null;
    companySize?: string | null;
    industry?: string | null;
    website?: string | null;
    idNumber?: string | null;
    bankName?: string | null;
  };
}

/**
 * Verbatim historical CLIENT completion formula. Originally inline in
 * profile.service.ts#getProfile() (present since the project's very first
 * commit, confirmed via `git show <initial-commit>:src/services/profile.service.ts`),
 * later ported to scripts/backfill-role-profile-fields.ts's
 * computeClientCompletionScore() for the Phase 3B backfill. Same fields,
 * same weights (base 7.5 x4, meta 6.0 x5, KYC 10.0 x2, banking 20/3 x3 = 100
 * max), same rounding/cap. This is the Phase 3D.2A runtime source of truth
 * for ClientProfile.completionPercentage — not a new/invented formula.
 *
 * Only change from the original raw `{...user, ...clientProfile}` merge:
 * firstName/lastName/avatarUrl/bankName/idNumber use an explicit
 * ClientProfile-first, User-fallback resolution instead. A raw spread lets
 * ClientProfile's value win even when it's an explicit `null` (Prisma always
 * returns nullable scalar columns as null, never undefined, once a row
 * exists), silently shadowing a real legacy User value — the exact bug
 * already found and fixed for firstName/lastName/avatarUrl in the Phase 3B
 * backfill script (commit "fix: preserve client identity fields in
 * completion backfill"); bankName and idNumber have the identical exposure
 * (both columns exist, under the same name, on both User and ClientProfile)
 * and are fixed here the same way. ibanNumber and accountHolderName have no
 * risk — ClientProfile has no matching column names for those (it calls them
 * `iban`/`accountHolder`), so they always resolve to User's value, exactly
 * as the original formula always did.
 */
export function computeClientCompletion(input: ClientCompletionInput): number {
  const { user, clientProfile } = input;

  const firstName = clientProfile.firstName || user.firstName;
  const lastName = clientProfile.lastName || user.lastName;
  const avatarUrl = clientProfile.avatarUrl || user.avatarUrl;
  const bankName = clientProfile.bankName || user.bankName;
  const idNumber = clientProfile.idNumber || user.idNumber;

  let score = 0;

  // base fields: +7.5 each
  if (firstName) score += 7.5;
  if (lastName) score += 7.5;
  if (user.phoneNumber) score += 7.5; // identity-level, always from User
  if (avatarUrl) score += 7.5;

  // meta fields: +6.0 each (none of these exist on User, no ambiguity)
  if (clientProfile.bio) score += 6.0;
  if (clientProfile.companyName) score += 6.0;
  if (clientProfile.companySize) score += 6.0;
  if (clientProfile.industry) score += 6.0;
  if (clientProfile.website) score += 6.0;

  // KYC fields: +10.0 each
  if (idNumber) score += 10.0;
  if (user.idExpiryDate) score += 10.0; // only ever exists on User

  // banking fields: +(20/3) each. A PayPal payout email is a full substitute
  // for the bank trio (PayPal-only clients have no IBAN and must not be capped).
  if (clientProfile.paypalPayoutEmail) {
    score += 20;
  } else {
    if (user.ibanNumber) score += (20 / 3);
    if (bankName) score += (20 / 3);
    if (user.accountHolderName) score += (20 / 3);
  }

  return Math.min(100, Math.round(score));
}

export interface ProviderCompletionInput {
  providerProfile: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    headline?: string | null;
    mainSpecialty?: string | null;
    bio?: string | null;
    skills?: unknown[] | null;
    portfolioItems?: unknown[] | null;
    websiteUrl?: string | null;
    country?: string | null;
    city?: string | null;
    /** The provider's confirmed PayPal payout destination (replaces User.ibanNumber in the score). */
    paypalPayoutEmail?: string | null;
  };
  user: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
    /** No longer scored (payouts are PayPal); kept in the type so existing callers still compile. */
    ibanNumber?: string | null;
    idDocumentUrl?: string | null;
  };
}

/** The profile page that can fix the item (frontend tab ids of the provider edit page). */
export type CompletionTab = 'profile' | 'contact' | 'payout' | 'docs';
export type CompletionItemStatus = 'missing' | 'pending_review';
export interface CompletionMissingItem {
  key: string;
  label: string;
  points: number;
  status: CompletionItemStatus;
  tab: CompletionTab;
  /** Short Arabic hint on what exactly is needed. */
  hint: string;
}

interface ProviderCompletionRule {
  key: string;
  label: string;
  points: number;
  tab: CompletionTab;
  hint: string;
  met: (i: ProviderCompletionInput) => boolean;
}

/**
 * The provider formula as data: one rule per scoring input (10+15+15+10+10+10+10+10+10 = 100 max). computeProviderCompletion
 * sums the met rules and computeProviderMissingItems lists the unmet ones, so the percentage and the "what is missing"
 * list can never disagree.
 *
 * firstName/lastName/avatarUrl prefer this ProviderProfile row's own columns, falling back to the legacy User value (the
 * Phase 3D.1 fix). Payout: ProviderProfile.paypalPayoutEmail replaces User.ibanNumber (same 10 points) — providers are
 * paid through PayPal and no provider screen writes an IBAN.
 */
const PROVIDER_RULES: ProviderCompletionRule[] = [
  { key: 'avatar', label: 'الصورة الشخصية', points: 10, tab: 'profile', hint: 'أضف صورة شخصية',
    met: ({ providerProfile: p, user: u }) => !!(p.avatarUrl || u.avatarUrl) },
  { key: 'identity', label: 'الاسم والمسمى المهني والتخصص الرئيسي', points: 15, tab: 'profile', hint: 'أكمل الاسم والمسمى المهني والتخصص الرئيسي',
    met: ({ providerProfile: p, user: u }) => !!((p.firstName || u.firstName) && (p.lastName || u.lastName) && p.headline && p.mainSpecialty) },
  { key: 'bio', label: 'الوصف المهني', points: 15, tab: 'profile', hint: 'اكتب وصفًا مهنيًا من 50 حرفًا على الأقل',
    met: ({ providerProfile: p }) => !!(p.bio && p.bio.length >= 50) },
  { key: 'skills', label: 'المهارات', points: 10, tab: 'profile', hint: 'أضف مهارة واحدة على الأقل',
    met: ({ providerProfile: p }) => !!p.skills?.length },
  { key: 'portfolio', label: 'معرض الأعمال', points: 10, tab: 'profile', hint: 'أضف رابط معرض أعمالك',
    met: ({ providerProfile: p }) => !!(p.portfolioItems?.length || p.websiteUrl) },
  { key: 'contact', label: 'البريد ورقم الجوال', points: 10, tab: 'contact', hint: 'أضف البريد الإلكتروني ورقم الجوال',
    met: ({ user: u }) => !!(u.email && u.phoneNumber) },
  { key: 'location', label: 'الدولة والمدينة', points: 10, tab: 'profile', hint: 'اختر الدولة والمدينة',
    met: ({ providerProfile: p }) => !!(p.country && p.city) },
  { key: 'payout', label: 'حساب PayPal لاستلام المدفوعات', points: 10, tab: 'payout', hint: 'أضف بريد PayPal لاستلام المدفوعات',
    met: ({ providerProfile: p }) => !!(p.paypalPayoutEmail && p.paypalPayoutEmail.trim()) },
  { key: 'idDocument', label: 'مستند إثبات الهوية', points: 10, tab: 'docs', hint: 'ارفع مستند إثبات الهوية',
    met: ({ user: u }) => !!u.idDocumentUrl },
];

export function computeProviderCompletion(input: ProviderCompletionInput): number {
  const score = PROVIDER_RULES.reduce((sum, rule) => sum + (rule.met(input) ? rule.points : 0), 0);
  return Math.min(100, score);
}

/**
 * What is still needed to reach 100%. An ID document whose request is waiting for the human review is returned with
 * status 'pending_review' (the provider did their part; it is NOT missing), and does not count in the percentage until
 * it is approved (User.idDocumentUrl is only written on approval).
 */
export function computeProviderMissingItems(input: ProviderCompletionInput, options: { pendingDocumentReview?: boolean } = {}): CompletionMissingItem[] {
  const items: CompletionMissingItem[] = [];
  for (const rule of PROVIDER_RULES) {
    if (rule.met(input)) continue;
    const pending = rule.key === 'idDocument' && !!options.pendingDocumentReview;
    items.push({
      key: rule.key,
      label: rule.label,
      points: rule.points,
      tab: rule.tab,
      status: pending ? 'pending_review' : 'missing',
      hint: pending ? 'مستند الهوية قيد المراجعة' : rule.hint,
    });
  }
  return items;
}

export interface AffiliateCompletionInput {
  user: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  };
  affiliateProfile: {
    avatarUrl?: string | null;
    bio?: string | null;
    iban?: string | null;
  };
  marketingChannelsCount: number;
}

/**
 * Phase 3D.4: verbatim extraction of marketer-profile.service.ts's (private)
 * recalculateCompletion — identical fields, identical weights (avatar 15 +
 * bio 15 + >=1 marketing channel 20 + IBAN 20 + basic identity 30 = 100 max),
 * identical null/empty semantics. Extracted so role-creation initialization
 * (account-management.service.ts) can compute the exact same score from
 * already-known/fetched state without importing MarketerProfileService (a
 * DB-querying service class) — not a formula redesign.
 *
 * marketingChannelsCount replaces the original's
 * `profile.marketingChannels.length` — callers pass the count they already
 * have (0 at role creation, or `marketingChannels.length` when recalculating
 * an existing profile).
 */
export function computeAffiliateCompletion(input: AffiliateCompletionInput): number {
  const { user, affiliateProfile, marketingChannelsCount } = input;

  let percentage = 0;

  // Avatar (+15%)
  if (affiliateProfile.avatarUrl || user.avatarUrl) percentage += 15;

  // Bio (+15%)
  if (affiliateProfile.bio && affiliateProfile.bio.trim().length > 0) percentage += 15;

  // At least 1 Channel (+20%)
  if (marketingChannelsCount > 0) percentage += 20;

  // IBAN (+20%)
  if (affiliateProfile.iban && affiliateProfile.iban.trim().length > 0) percentage += 20;

  // User basic info (+30%)
  if (user.firstName && user.lastName && user.email) percentage += 30;

  return Math.min(100, percentage);
}
