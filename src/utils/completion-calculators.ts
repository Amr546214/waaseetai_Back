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

  // banking fields: +(20/3) each
  if (user.ibanNumber) score += (20 / 3);
  if (bankName) score += (20 / 3);
  if (user.accountHolderName) score += (20 / 3);

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
  };
  user: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
    ibanNumber?: string | null;
    idDocumentUrl?: string | null;
  };
}

/**
 * Verbatim extraction of provider-profile.service.ts's (private)
 * calculateProfileCompletion — identical fields, identical weights (10+15+
 * 15+10+10+10+10+10+10 = 100 max). Extracted only so
 * provider-profile.controller.ts's saveSetupData (a different file, plain
 * functions, not a class method) can reuse the exact same calculation
 * without duplicating it — not a formula redesign.
 *
 * firstName/lastName/avatarUrl already prefer this ProviderProfile row's own
 * Phase 3A columns, falling back to the legacy User value (the Phase 3D.1
 * fix) — preserved here unchanged.
 */
export function computeProviderCompletion(input: ProviderCompletionInput): number {
  const { providerProfile: profile, user } = input;

  const avatarUrl = profile.avatarUrl || user.avatarUrl;
  const firstName = profile.firstName || user.firstName;
  const lastName = profile.lastName || user.lastName;

  let score = 0;
  if (avatarUrl) score += 10;
  if (firstName && lastName && profile.headline && profile.mainSpecialty) score += 15;
  if (profile.bio && profile.bio.length >= 50) score += 15;
  if (profile.skills?.length) score += 10;
  if (profile.portfolioItems?.length || profile.websiteUrl) score += 10;
  if (user.email && user.phoneNumber) score += 10;
  if (profile.country && profile.city) score += 10;
  if (user.ibanNumber) score += 10;
  if (user.idDocumentUrl) score += 10;
  return Math.min(100, score);
}
