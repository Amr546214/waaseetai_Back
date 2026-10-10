// Phase 3D.2A: pure, side-effect-free profile-completion calculators.
// No Prisma imports, no dotenv, no DB, no service imports with side effects —
// each function takes already-fetched plain data and returns a number, so
// these can be unit-tested without ever loading db.ts.
//
// One calculator per role, not one shared formula — each preserves its own
// pre-existing field list and weights exactly (see the docstring on each
// function for provenance).

export interface ClientCompletionInput {
  user: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    /** CLIENT_COMPANY scores the company fields; every other account type is scored as an individual. */
    accountType?: string | null;
    idNumber?: string | null;
    // The legacy fields below are no longer scored (kept optional so existing callers keep compiling).
    phoneNumber?: string | null;
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

/** The profile page that can fix the item. 'setup' = the profile-setup wizard (the only place that collects it). */
export type CompletionTab = 'profile' | 'contact' | 'payout' | 'docs' | 'basics' | 'banking' | 'setup' | 'bank';
export type CompletionItemStatus = 'missing' | 'pending_review' | 'rejected';
export interface CompletionMissingItem {
  key: string;
  label: string;
  points: number;
  status: CompletionItemStatus;
  tab: CompletionTab;
  /** Short Arabic hint on what exactly is needed. */
  hint: string;
}

interface CompletionRule<I> {
  key: string;
  label: string;
  points: number;
  tab: CompletionTab;
  hint: string;
  met: (i: I) => boolean;
}

const clientName = ({ user: u, clientProfile: p }: ClientCompletionInput) => !!((p.firstName || u.firstName) && (p.lastName || u.lastName));
const clientAvatar = ({ user: u, clientProfile: p }: ClientCompletionInput) => !!(p.avatarUrl || u.avatarUrl);
const clientIdNumber = ({ user: u, clientProfile: p }: ClientCompletionInput) => !!(p.idNumber || u.idNumber);
const clientPaypal = ({ clientProfile: p }: ClientCompletionInput) => !!(p.paypalPayoutEmail && p.paypalPayoutEmail.trim());
const filled = (v: string | null | undefined) => !!(v && v.trim());

const AVATAR = (points: number): CompletionRule<ClientCompletionInput> => ({ key: 'avatar', label: 'الصورة الشخصية', points, tab: 'profile', hint: 'أضف صورة شخصية', met: clientAvatar });
const NAME = (points: number): CompletionRule<ClientCompletionInput> => ({ key: 'name', label: 'الاسم الأول واسم العائلة', points, tab: 'basics', hint: 'أكمل الاسم الأول واسم العائلة', met: clientName });
const BIO = (points: number, hint: string): CompletionRule<ClientCompletionInput> => ({ key: 'bio', label: 'النبذة التعريفية', points, tab: 'profile', hint, met: ({ clientProfile: p }) => filled(p.bio) });
const ID_NUMBER = (points: number): CompletionRule<ClientCompletionInput> => ({ key: 'idNumber', label: 'رقم الهوية الوطنية', points, tab: 'setup', hint: 'أضف رقم الهوية من صفحة استكمال البيانات', met: clientIdNumber });
const PAYPAL: CompletionRule<ClientCompletionInput> = { key: 'payout', label: 'حساب PayPal لاستلام المدفوعات', points: 20, tab: 'banking', hint: 'أضف بريد PayPal لاستلام المدفوعات', met: clientPaypal };

/**
 * CLIENT_INDIVIDUAL: only what an individual can fill from the UI, weighted to 100 (15+15+15+15+20+20).
 * The "current profession" is the wizard's occupation (stored in ClientProfile.industry); it is only collected by the wizard.
 */
const CLIENT_INDIVIDUAL_RULES: CompletionRule<ClientCompletionInput>[] = [
  AVATAR(15), NAME(15), BIO(15, 'أضف نبذة تعريفية عن نفسك'),
  { key: 'industry', label: 'المهنة الحالية', points: 15, tab: 'setup', hint: 'أضف مهنتك الحالية من صفحة استكمال البيانات', met: ({ clientProfile: p }) => filled(p.industry) },
  ID_NUMBER(20), PAYPAL,
];

/** CLIENT_COMPANY: adds the company fields (10 each: 10+10+10+10+10+10+10+10+20 = 100). */
const CLIENT_COMPANY_RULES: CompletionRule<ClientCompletionInput>[] = [
  AVATAR(10), NAME(10), BIO(10, 'أضف نبذة تعريفية عن شركتك'),
  { key: 'companyName', label: 'اسم الشركة', points: 10, tab: 'profile', hint: 'أضف اسم الشركة', met: ({ clientProfile: p }) => filled(p.companyName) },
  { key: 'companySize', label: 'حجم الشركة', points: 10, tab: 'profile', hint: 'اختر حجم الشركة', met: ({ clientProfile: p }) => filled(p.companySize) },
  { key: 'industry', label: 'مجال العمل', points: 10, tab: 'profile', hint: 'أضف مجال عمل الشركة', met: ({ clientProfile: p }) => filled(p.industry) },
  { key: 'website', label: 'الموقع الإلكتروني', points: 10, tab: 'profile', hint: 'أضف الموقع الإلكتروني للشركة', met: ({ clientProfile: p }) => filled(p.website) },
  ID_NUMBER(10), PAYPAL,
];

const clientRulesFor = (input: ClientCompletionInput) =>
  input.user.accountType === 'CLIENT_COMPANY' ? CLIENT_COMPANY_RULES : CLIENT_INDIVIDUAL_RULES;

/**
 * Client completion, one formula per account type, each weighted to 100 over inputs the UI can actually fill.
 * Removed from the score: User.phoneNumber (read-only, set at signup), User.idExpiryDate (no writer anywhere) and the bank
 * trio (IBAN / bank name / account holder). PayPal is the only payout item (+20). The same rules produce the missing list,
 * so the percentage and "what is missing" cannot disagree. ClientProfile-first, User-fallback for name/avatar/idNumber.
 */
export function computeClientCompletion(input: ClientCompletionInput): number {
  const score = clientRulesFor(input).reduce((sum, rule) => sum + (rule.met(input) ? rule.points : 0), 0);
  return Math.min(100, score);
}

/** What is still needed to reach 100% for this client (nothing here is ever "pending review"). */
export function computeClientMissingItems(input: ClientCompletionInput): CompletionMissingItem[] {
  return clientRulesFor(input)
    .filter(rule => !rule.met(input))
    .map(rule => ({ key: rule.key, label: rule.label, points: rule.points, tab: rule.tab, status: 'missing' as const, hint: rule.hint }));
}

export interface ProviderCompletionInput {
  providerProfile: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    headline?: string | null;
    /** Older wizard saves stored the job title here only; it still counts as the headline. */
    industry?: string | null;
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
    met: ({ providerProfile: p, user: u }) => !!((p.firstName || u.firstName) && (p.lastName || u.lastName) && (p.headline || p.industry) && p.mainSpecialty) },
  { key: 'bio', label: 'الوصف المهني', points: 15, tab: 'profile', hint: 'اكتب وصفًا مهنيًا من 50 حرفًا على الأقل',
    met: ({ providerProfile: p }) => !!(p.bio && p.bio.length >= 50) },
  { key: 'skills', label: 'المهارات', points: 10, tab: 'profile', hint: 'أضف مهارة واحدة على الأقل',
    met: ({ providerProfile: p }) => !!p.skills?.length },
  { key: 'portfolio', label: 'معرض الأعمال', points: 10, tab: 'profile', hint: 'أضف رابط معرض أعمالك (Behance أو GitHub أو موقعك الشخصي) في قسم «الروابط الشخصية»',
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
export function computeProviderMissingItems(input: ProviderCompletionInput, options: { pendingDocumentReview?: boolean; rejectedIdentity?: boolean } = {}): CompletionMissingItem[] {
  const items: CompletionMissingItem[] = [];
  for (const rule of PROVIDER_RULES) {
    // a refused identity review is never "complete", even with a stored document: it needs a new one (unless a new one is already waiting)
    const rejected = rule.key === 'idDocument' && !!options.rejectedIdentity && !options.pendingDocumentReview;
    if (rule.met(input) && !rejected) continue;
    const pending = rule.key === 'idDocument' && !!options.pendingDocumentReview && !rule.met(input);
    items.push({
      key: rule.key,
      label: rule.label,
      points: rule.points,
      tab: rule.tab,
      status: rejected ? 'rejected' : pending ? 'pending_review' : 'missing',
      hint: rejected ? 'مرفوض — يحتاج تعديل' : pending ? 'مستند الهوية قيد المراجعة' : rule.hint,
    });
  }
  return items;
}

export interface AffiliateCompletionInput {
  user: {
    avatarUrl?: string | null;
    // Names and email are no longer scored (set at signup, not completable from the UI); kept optional so callers compile.
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  };
  affiliateProfile: {
    avatarUrl?: string | null;
    bio?: string | null;
    /** The saved PayPal payout email (the only payout destination). */
    paypalPayoutEmail?: string | null;
  };
  marketingChannelsCount: number;
}

/** A marketing bio only counts from this many characters (the maximum is enforced on save). */
export const AFFILIATE_BIO_MIN_LENGTH = 50;
export const AFFILIATE_BIO_MAX_LENGTH = 500;

const AFFILIATE_RULES: CompletionRule<AffiliateCompletionInput>[] = [
  { key: 'avatar', label: 'الصورة الشخصية', points: 20, tab: 'profile', hint: 'أضف صورة شخصية',
    met: ({ user: u, affiliateProfile: p }) => !!(p.avatarUrl || u.avatarUrl) },
  { key: 'bio', label: 'الوصف التسويقي', points: 20, tab: 'profile', hint: `اكتب وصفًا تسويقيًا من ${AFFILIATE_BIO_MIN_LENGTH} حرفًا على الأقل`,
    met: ({ affiliateProfile: p }) => !!(p.bio && p.bio.trim().length >= AFFILIATE_BIO_MIN_LENGTH) },
  { key: 'channel', label: 'قناة تسويقية', points: 30, tab: 'profile', hint: 'أضف قناة تسويقية واحدة على الأقل',
    met: ({ marketingChannelsCount }) => marketingChannelsCount > 0 },
  { key: 'payout', label: 'بريد PayPal', points: 30, tab: 'bank', hint: 'أضف بريد PayPal لاستلام الأرباح',
    met: ({ affiliateProfile: p }) => !!(p.paypalPayoutEmail && p.paypalPayoutEmail.trim().length > 0) },
];

/**
 * Marketer completion, weighted to 100 over what the marketer can do: avatar 20, bio 20 (>= 50 characters), at least one
 * channel 30 (no verification needed yet), PayPal email 30. Names and email are not scored.
 */
export function computeAffiliateCompletion(input: AffiliateCompletionInput): number {
  const score = AFFILIATE_RULES.reduce((sum, rule) => sum + (rule.met(input) ? rule.points : 0), 0);
  return Math.min(100, score);
}

export function computeAffiliateMissingItems(input: AffiliateCompletionInput): CompletionMissingItem[] {
  const items: CompletionMissingItem[] = [];
  for (const rule of AFFILIATE_RULES) {
    if (rule.met(input)) continue;
    items.push({
      key: rule.key,
      label: rule.label,
      points: rule.points,
      tab: rule.tab,
      status: 'missing',
      hint: rule.hint,
    });
  }
  return items;
}
