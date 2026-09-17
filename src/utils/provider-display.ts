// Phase 3E.1: a pure, side-effect-free resolver for a THIRD PARTY's Provider
// display identity (public profile, marketplace listings/detail, AI result
// cards). Unlike role-display-resolver.ts — which resolves the CURRENT
// USER's own active-role identity and therefore branches on activeRole —
// every caller of this function already knows unambiguously that the target
// is a Provider (that's what makes them appear in these contexts), so no
// role branching is needed here at all.
//
// ProviderProfile's own Phase 3A/3D.1 display columns win; the legacy shared
// User columns are used only when the corresponding ProviderProfile value is
// null/undefined/empty. No Prisma imports, no DB, no service imports with
// side effects — takes already-fetched plain data and returns a resolved
// identity, so this can be unit-tested without ever loading db.ts.

export interface ProviderDisplayIdentityInput {
  providerProfile: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
  };
  user: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
  };
}

export interface ProviderDisplayIdentity {
  firstName: string;
  lastName: string;
  fullName: string;
  avatarUrl: string | null;
}

export function resolveProviderDisplayIdentity(input: ProviderDisplayIdentityInput): ProviderDisplayIdentity {
  const firstName = input.providerProfile.firstName || input.user.firstName || '';
  const lastName = input.providerProfile.lastName || input.user.lastName || '';
  const avatarUrl = input.providerProfile.avatarUrl || input.user.avatarUrl || null;
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    avatarUrl
  };
}
