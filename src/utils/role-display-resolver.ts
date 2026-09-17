import type { ClientProfile, ProviderProfile, ProviderGamification, AffiliateProfile, UserRole } from '@prisma/client';
import { LEVEL_MATRIX } from '../services/gamification.service';

// Phase 3C: resolves the currently authenticated user's flat, frontend-compatible
// display/progression fields from their CURRENTLY ACTIVE role's profile instead of
// the legacy global User columns. See API_AUDIT / Phase 3C notes for the full
// role -> field -> fallback table this implements.

export interface LegacyUserDisplayFields {
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  profileCompletionPercent: number;
  currentLevel: string;
  currentPoints: number;
  pointsToNextLevel: number;
}

export type ActiveRoleDisplayFields = LegacyUserDisplayFields;

// Partial: callers commonly `select` only the columns they need (e.g. a
// dashboard summary query has no reason to also fetch firstName/avatarUrl),
// so every field here is optional — resolution below treats a missing field
// exactly like a null one (falls back to the legacy User column).
type ClientProfileDisplay = Partial<Pick<ClientProfile, 'firstName' | 'lastName' | 'avatarUrl' | 'currentLevel' | 'currentPoints' | 'pointsToNextLevel' | 'completionPercentage'>>;
type ProviderProfileDisplay = Partial<Pick<ProviderProfile, 'firstName' | 'lastName' | 'avatarUrl' | 'completionPercentage'>>;
type ProviderGamificationDisplay = Partial<Pick<ProviderGamification, 'points' | 'currentLevelIndex'>>;
type AffiliateProfileDisplay = Partial<Pick<AffiliateProfile, 'firstName' | 'lastName' | 'avatarUrl' | 'currentLevel' | 'completionPercentage'>>;

export interface ResolveActiveRoleDisplayFieldsParams {
  activeRole: UserRole | null | undefined;
  legacy: LegacyUserDisplayFields;
  clientProfile?: ClientProfileDisplay | null;
  providerProfile?: ProviderProfileDisplay | null;
  providerGamification?: ProviderGamificationDisplay | null;
  affiliateProfile?: AffiliateProfileDisplay | null;
}

// FALLBACK RULE (Phase 3C): a role-specific field counts as "unset" when it is
// null/undefined or an empty/whitespace-only string, in which case we fall back
// to the corresponding legacy User column. Numeric 0 is a valid value, never a
// trigger for fallback. Pure — never mutates its inputs.
function withFallback<T>(value: T | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  return value;
}

/**
 * Provider progression source of truth: LEVEL_MATRIX (gamification.service.ts)
 * for level titles/point thresholds, and the already-fetched ProviderGamification
 * row (points, currentLevelIndex) for the provider's current standing. This is a
 * pure lookup — it deliberately does NOT call gamificationService.getLevelDetails(),
 * which recomputes stats from scratch and upserts ProviderGamification as a side
 * effect (correct for its own dedicated endpoint, wrong for a shared read-only
 * resolver that must never write).
 *
 * Falls back to the legacy User progression fields only if the provider has no
 * ProviderGamification row at all (should be rare post Phase 3B backfill, but
 * must not crash a current-user read if it happens).
 */
export function resolveProviderProgression(
  gamification: ProviderGamificationDisplay | null | undefined,
  legacy: LegacyUserDisplayFields
): Pick<ActiveRoleDisplayFields, 'currentPoints' | 'currentLevel' | 'pointsToNextLevel'> {
  if (!gamification) {
    return {
      currentPoints: legacy.currentPoints,
      currentLevel: legacy.currentLevel,
      pointsToNextLevel: legacy.pointsToNextLevel
    };
  }

  const points = gamification.points ?? 0;
  const levelIndex = gamification.currentLevelIndex || 1;
  const currentLevelDef = LEVEL_MATRIX.find(level => level.index === levelIndex) || LEVEL_MATRIX[0];
  const nextLevelDef = LEVEL_MATRIX.find(level => level.index === Math.min(levelIndex + 1, LEVEL_MATRIX.length)) || currentLevelDef;
  const pointsToNextLevel = Math.max(0, nextLevelDef.reqPoints - points);

  return {
    currentPoints: points,
    currentLevel: currentLevelDef.title,
    pointsToNextLevel
  };
}

/**
 * Resolves the currently authenticated user's flat display/progression fields
 * from their CURRENTLY ACTIVE role — not accountType, and not the legacy User
 * columns unless the role-specific value (or the whole role profile) is missing.
 *
 * Pure and read-only: takes already-fetched rows, performs no I/O, and never
 * mutates anything. Callers fetch whichever relations they need (clientProfile /
 * providerProfile / providerGamification / affiliateProfile) alongside the
 * legacy User row.
 */
export function resolveActiveRoleDisplayFields(params: ResolveActiveRoleDisplayFieldsParams): ActiveRoleDisplayFields {
  const { activeRole, legacy, clientProfile, providerProfile, providerGamification, affiliateProfile } = params;

  if (activeRole === 'CLIENT') {
    return {
      firstName: withFallback(clientProfile?.firstName, legacy.firstName),
      lastName: withFallback(clientProfile?.lastName, legacy.lastName),
      avatarUrl: withFallback(clientProfile?.avatarUrl, legacy.avatarUrl),
      profileCompletionPercent: withFallback(clientProfile?.completionPercentage, legacy.profileCompletionPercent),
      currentLevel: withFallback(clientProfile?.currentLevel, legacy.currentLevel),
      currentPoints: withFallback(clientProfile?.currentPoints, legacy.currentPoints),
      pointsToNextLevel: withFallback(clientProfile?.pointsToNextLevel, legacy.pointsToNextLevel)
    };
  }

  if (activeRole === 'PROVIDER') {
    return {
      firstName: withFallback(providerProfile?.firstName, legacy.firstName),
      lastName: withFallback(providerProfile?.lastName, legacy.lastName),
      avatarUrl: withFallback(providerProfile?.avatarUrl, legacy.avatarUrl),
      profileCompletionPercent: withFallback(providerProfile?.completionPercentage, legacy.profileCompletionPercent),
      ...resolveProviderProgression(providerGamification, legacy)
    };
  }

  if (activeRole === 'AFFILIATE') {
    return {
      firstName: withFallback(affiliateProfile?.firstName, legacy.firstName),
      lastName: withFallback(affiliateProfile?.lastName, legacy.lastName),
      avatarUrl: withFallback(affiliateProfile?.avatarUrl, legacy.avatarUrl),
      profileCompletionPercent: withFallback(affiliateProfile?.completionPercentage, legacy.profileCompletionPercent),
      currentLevel: withFallback(affiliateProfile?.currentLevel, legacy.currentLevel),
      // No points-based progression concept exists for affiliates (Phase 3A
      // intentionally did not add one). Preserve API compatibility by returning
      // the legacy User values unchanged instead of inventing fake progression.
      currentPoints: legacy.currentPoints,
      pointsToNextLevel: legacy.pointsToNextLevel
    };
  }

  // ADMIN / SUPER_ADMIN / unset activeRole: no role-profile concept exists,
  // so the legacy User columns remain authoritative as-is.
  return { ...legacy };
}
