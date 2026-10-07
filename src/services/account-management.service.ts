import jwt from 'jsonwebtoken';
import { UserRole, AccountType, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { generateReferralSlug } from '../utils/slug.util';
import { accountAuditLogService, AuditContext } from './account-logs.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';
import { computeClientCompletion, computeProviderCompletion, computeAffiliateCompletion } from '../utils/completion-calculators';
import { deriveProviderProgression } from '../utils/progression-calculators';

/**
 * Helper to derive primary UserRole from AccountType enum
 */
/**
 * Roles a user may ever acquire through a self-service request (addAccountType
 * / switchActiveRole). ADMIN and SUPER_ADMIN are deliberately excluded — those
 * are internal/operator roles provisioned out-of-band, never through a
 * request an authenticated user's own client can send. This is the
 * service-layer half of a defense-in-depth pair whose first layer is the Zod
 * `SelfServiceUserRoleEnum` in account-management.dto.ts: the DTO stops a
 * malformed request at the edge, this stops it even if some other internal
 * caller ever invokes addAccountType directly with an unchecked role.
 */
const SELF_SERVICE_ROLES: ReadonlySet<UserRole> = new Set([UserRole.CLIENT, UserRole.PROVIDER, UserRole.AFFILIATE]);

export function getRoleFromAccountType(accountType: AccountType): UserRole {
  if (accountType === 'PROVIDER_INDIVIDUAL' || accountType === 'PROVIDER_COMPANY') {
    return UserRole.PROVIDER;
  }
  if (accountType === 'MARKETING_BROKER') {
    return UserRole.AFFILIATE;
  }
  return UserRole.CLIENT;
}

/**
 * Derive the initial `roles` array a brand-new user should be created with,
 * based on their chosen accountType. Mirrors the self-healing merge already
 * done in getAvailableAccountTypes (primaryRole + the schema's default
 * `roles: [CLIENT]`) so a freshly created row matches what that lazy repair
 * would have produced anyway — providers and affiliates also get an implicit
 * CLIENT role, consistent with existing behavior.
 */
export function getInitialRolesForAccountType(accountType: AccountType): UserRole[] {
  const primaryRole = getRoleFromAccountType(accountType);
  if (primaryRole === UserRole.CLIENT) {
    return [UserRole.CLIENT];
  }
  return [primaryRole, UserRole.CLIENT];
}

export interface CreateMissingRoleProfilesResult {
  clientCreated: boolean;
  providerCreated: boolean;
  affiliateCreated: boolean;
}

/**
 * Phase 3D.4: the shared User identity fields every role-completion
 * calculator needs, in one shape every role-creation/self-healing call site
 * can build from whatever User row it already has in scope (a freshly
 * created row, a `findUnique` result, etc.) — never a new DB read of its own.
 * Banking/KYC fields are legitimately null for most callers (e.g. brand-new
 * registrations); the calculators already treat null/missing as "not
 * scored", so this never invents data.
 */
export interface RoleInitializationIdentity {
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  idNumber?: string | null;
  idExpiryDate?: unknown;
  ibanNumber?: string | null;
  bankName?: string | null;
  accountHolderName?: string | null;
  idDocumentUrl?: string | null;
  /** Needed by the CLIENT completion formula (CLIENT_COMPANY scores the company fields). */
  accountType?: string | null;
}

/**
 * Phase 3D.4: the single canonical place a role-specific profile row — and,
 * for PROVIDER, its ProviderGamification row — is created with correct
 * initial state instead of a bare `{ userId }` row. On first creation only:
 *
 *  - seeds firstName/lastName/avatarUrl from the shared User identity (never
 *    re-synced afterward — that's Phase 3D.1's job to keep independent)
 *  - computes a REAL initial completionPercentage from that exact seeded
 *    state, using the exact existing Phase 3D.2 pure calculators (no new
 *    formula) — so a profile that already legitimately has a name/avatar
 *    never sits at an incorrect 0% until the first manual edit
 *  - for PROVIDER, ensures a correct zero-state ProviderGamification row via
 *    the exact existing Phase 3D.3A pure calculator (no hardcoded
 *    index/commission, no PointTransaction)
 *
 * Idempotent: does nothing for a role whose profile row already exists —
 * independent/existing display, completion and progression data is NEVER
 * reset. ProviderProfile and ProviderGamification existence are checked and
 * repaired INDEPENDENTLY of each other, so a pre-3D.4 provider that already
 * has a ProviderProfile row but no ProviderGamification row gets only the
 * missing gamification row created (never touching the existing profile),
 * and an existing ProviderGamification row is never reset.
 *
 * `extraFields` lets a caller supply additional, already-Prisma-shaped
 * role-profile columns on top of the seeded display fields (e.g.
 * addAccountType's richer companyName/headline/bio metadata, or
 * client-requests.service.ts's `isProfileComplete: true`) — this function
 * has no knowledge of any request DTO's own field names; that translation
 * stays entirely in the caller, so no formula or mapping is duplicated here.
 *
 * This is used by every role-creation/self-healing site in the app:
 * email/password + Google registration (via createMissingRoleProfiles
 * below), addAccountType, the self-healing path in getAvailableAccountTypes,
 * the MARKETING_BROKER OTP-verification fallback, and the three previously-
 * independent scattered self-heals (provider-profile.service.ts#getProfile,
 * client-requests.service.ts#createRequest, marketer-overview.service.ts).
 */
export async function initializeRoleState(
  tx: Prisma.TransactionClient,
  userId: string,
  role: UserRole,
  identity: RoleInitializationIdentity,
  extraFields?: Record<string, unknown>
): Promise<boolean> {
  if (role === UserRole.CLIENT) {
    // Explicit select — deployment-safety fix (same reason as the AFFILIATE branch below): a default
    // select reads every ClientProfile column, so a database that is missing a newer column (e.g.
    // paypalPayoutEmail before its ALTER is applied) made EVERY add-account call 500, even though this
    // is only an existence check.
    const existing = await tx.clientProfile.findUnique({ where: { userId }, select: { id: true } });
    if (existing) return false;

    const seeded = {
      firstName: identity.firstName,
      lastName: identity.lastName,
      avatarUrl: identity.avatarUrl ?? null,
      ...extraFields
    };
    const completionPercentage = computeClientCompletion({ user: identity, clientProfile: seeded });
    await tx.clientProfile.create({ data: { userId, ...seeded, completionPercentage }, select: { id: true } });
    return true;
  }

  if (role === UserRole.PROVIDER) {
    let created = false;

    const existingProfile = await tx.providerProfile.findUnique({ where: { userId } });
    if (!existingProfile) {
      const seeded = {
        firstName: identity.firstName,
        lastName: identity.lastName,
        avatarUrl: identity.avatarUrl ?? null,
        ...extraFields
      };
      const completionPercentage = computeProviderCompletion({ providerProfile: seeded, user: identity });
      await tx.providerProfile.create({ data: { userId, ...seeded, completionPercentage } });
      created = true;
    }

    // Independent of ProviderProfile existence: a pre-3D.4 provider may
    // already have a ProviderProfile row but no ProviderGamification row
    // (the only writers before this phase were project completion / a
    // rating / GET /gamification/level-details — all lazy, none at creation
    // time). Never reset an existing ProviderGamification row's real
    // points/completedProjects/avgRating/currentLevelIndex/currentCommission.
    const existingGamification = await tx.providerGamification.findUnique({ where: { providerId: userId } });
    if (!existingGamification) {
      const progression = deriveProviderProgression({ points: 0, completedProjects: 0, avgRating: 0 });
      await tx.providerGamification.create({
        data: {
          providerId: userId,
          points: 0,
          completedProjects: 0,
          avgRating: 0,
          currentLevelIndex: progression.currentLevelIndex,
          currentCommission: progression.currentCommission
        }
      });
      created = true;
    }

    return created;
  }

  if (role === UserRole.AFFILIATE) {
    // Explicit select — deployment-safety fix; only used as an existence
    // check. AffiliateProfile.level exists in the Prisma schema but its
    // migration has not been applied to DEV/LIVE yet, so default selection
    // here would 500 every role-creation/self-healing path that reaches this
    // branch (registration, addAccountType, getAvailableAccountTypes, etc.).
    const existing = await tx.affiliateProfile.findUnique({ where: { userId }, select: { id: true } });
    if (existing) return false;

    // Fresh random slug, checked for a free value inside this same transaction (the unique constraint stays the final guard: a
    // concurrent collision aborts the whole registration transaction and the caller retries it — never an account without its profile).
    let referralSlug = generateReferralSlug(`${identity.firstName} ${identity.lastName}`, userId);
    for (let attempt = 0; attempt < 5 && await tx.affiliateProfile.findUnique({ where: { referralSlug }, select: { id: true } }); attempt++) {
      referralSlug = generateReferralSlug(`${identity.firstName} ${identity.lastName}`, userId);
    }
    const seeded = {
      firstName: identity.firstName,
      lastName: identity.lastName,
      avatarUrl: identity.avatarUrl ?? null,
      ...extraFields
    };
    // Zero marketing channels at creation — always true for a brand-new row,
    // never a DB read of its own.
    const completionPercentage = computeAffiliateCompletion({
      user: identity,
      affiliateProfile: seeded,
      marketingChannelsCount: 0
    });
    // Explicit select — deployment-safety fix; return value unused.
    await tx.affiliateProfile.create({ data: { userId, referralSlug, ...seeded, completionPercentage }, select: { id: true } });
    return true;
  }

  return false;
}

/**
 * Ensure every role in `roles` has its matching profile row (+ for PROVIDER,
 * its ProviderGamification row) for this user, via initializeRoleState — a
 * thin per-role loop, kept as its own export since every existing call site
 * (email/password registration, Google sign-up, addAccountType's defensive
 * backfill, getAvailableAccountTypes, scripts/backfill-role-profiles.ts)
 * already calls it with a role list rather than one role at a time.
 *
 * Idempotent and safe to call repeatedly / concurrently with itself — see
 * initializeRoleState's own idempotency guarantees.
 *
 * MARKETING_BROKER/AFFILIATE never implies a ProviderProfile — nothing in the
 * app reads a broker's providerProfile (marketer-overview.service.ts only
 * reads affiliateProfile), so a caller must pass UserRole.PROVIDER explicitly
 * if a user is genuinely both a provider and an affiliate.
 */
export async function createMissingRoleProfiles(
  tx: Prisma.TransactionClient,
  userId: string,
  roles: UserRole[],
  identity: RoleInitializationIdentity
): Promise<CreateMissingRoleProfilesResult> {
  const result: CreateMissingRoleProfilesResult = {
    clientCreated: false,
    providerCreated: false,
    affiliateCreated: false
  };

  if (roles.includes(UserRole.CLIENT)) {
    result.clientCreated = await initializeRoleState(tx, userId, UserRole.CLIENT, identity);
  }
  if (roles.includes(UserRole.PROVIDER)) {
    result.providerCreated = await initializeRoleState(tx, userId, UserRole.PROVIDER, identity);
  }
  if (roles.includes(UserRole.AFFILIATE)) {
    result.affiliateCreated = await initializeRoleState(tx, userId, UserRole.AFFILIATE, identity);
  }

  return result;
}

export class AccountManagementService {
  /**
   * Fetch available account types for the user (owned vs available)
   */
  public async getAvailableAccountTypes(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        email: true,
        phoneNumber: true,
        idNumber: true,
        idExpiryDate: true,
        ibanNumber: true,
        bankName: true,
        accountHolderName: true,
        idDocumentUrl: true,
        roles: true,
        activeRole: true,
        accountType: true,
        clientProfile: { select: { id: true } },
        providerProfile: { select: { id: true } },
        affiliateProfile: { select: { id: true } },
        gamification: { select: { id: true } }
      }
    });

    if (!user) {
      throw new AppError('حساب المستخدم غير موجود', 404);
    }

    const primaryRole = getRoleFromAccountType(user.accountType);
    let userRoles: UserRole[] = Array.from(new Set([primaryRole, ...(user.roles || [])]));
    let activeRole: UserRole = user.activeRole || primaryRole;

    // Self-healing check: If DB roles/activeRole was out of sync due to default schema values, persist correct values
    const needsRoleUpdate = !user.roles || !user.roles.includes(primaryRole) || user.activeRole !== activeRole;

    // Self-healing also covers profile rows (+ for PROVIDER, its
    // ProviderGamification row): an older signup path (or a partial/failed
    // transaction) may have left this user owning a role with no matching
    // profile/progression row.
    const missingClient = userRoles.includes(UserRole.CLIENT) && !user.clientProfile;
    const missingProvider = userRoles.includes(UserRole.PROVIDER) && (!user.providerProfile || !user.gamification);
    const missingAffiliate = userRoles.includes(UserRole.AFFILIATE) && !user.affiliateProfile;

    // Phase 3D.4: both repairs used to be two separate, non-transactional
    // statements — a crash between them could leave User.roles claiming a
    // role with no matching profile row. Now atomic together, and skipped
    // entirely (no transaction opened at all) when nothing actually needs
    // repairing, which is the common case for every already-consistent user.
    if (needsRoleUpdate || missingClient || missingProvider || missingAffiliate) {
      await prisma.$transaction(async (tx) => {
        if (needsRoleUpdate) {
          await tx.user.update({
            where: { id: userId },
            data: { roles: userRoles, activeRole: activeRole }
          });
        }
        await createMissingRoleProfiles(tx, userId, userRoles, {
          firstName: user.firstName,
          lastName: user.lastName,
          avatarUrl: user.avatarUrl,
          email: user.email,
          phoneNumber: user.phoneNumber,
          idNumber: user.idNumber,
          idExpiryDate: user.idExpiryDate,
          ibanNumber: user.ibanNumber,
          bankName: user.bankName,
          accountHolderName: user.accountHolderName,
          idDocumentUrl: user.idDocumentUrl,
          accountType: user.accountType
        });
      });
    }

    const allRoles: { role: UserRole; label: string; color: string; description: string }[] = [
      {
        role: UserRole.CLIENT,
        label: 'طالب الخدمة',
        color: '#2BD4C7',
        description: 'للأفراد والشركات الذين يطلبون خدمات من مقدمين موثقين بضمان مالي'
      },
      {
        role: UserRole.PROVIDER,
        label: 'مقدم الخدمة',
        color: '#5DA0FF',
        description: 'للمستقلين والشركات الذين يقدمون خدماتهم الاحترافية للعملاء'
      },
      {
        role: UserRole.AFFILIATE,
        label: 'الوسيط التسويقي',
        color: '#D98A0B',
        description: 'اكسب عمولة تلقائية عند تقديم العملاء وإبرام العقود عبر المنصة'
      }
    ];

    const ownedRoles = userRoles;
    const availableRoles = allRoles.filter(r => !ownedRoles.includes(r.role));

    return {
      activeRole,
      roles: userRoles,
      ownedRoles,
      availableRoles,
      allRoles
    };
  }

  /**
   * Add a new account role to the user and auto-create profile via prisma transaction
   */
  public async addAccountType(
    userId: string,
    targetRole: UserRole,
    profileMetadata?: Record<string, any>,
    auditContext?: AuditContext
  ) {
    if (!SELF_SERVICE_ROLES.has(targetRole)) {
      throw new AppError('الدور المطلوب غير متاح للإضافة الذاتية', 403);
    }

    // Deployment-safety fix: this query's `clientProfile`/`providerProfile`/
    // `affiliateProfile` relations were never actually read anywhere in this
    // method (verified — only user's own scalar fields below are used), so
    // the unused `include` is dropped entirely rather than converted to a
    // select. It previously fetched AffiliateProfile's full default scalar
    // set (including the not-yet-migrated `level` column) for no reason,
    // which would 500 this add-account-type path.
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new AppError('حساب المستخدم غير موجود', 404);
    }

    const primaryRole = getRoleFromAccountType(user.accountType);
    const currentRoles: UserRole[] = Array.from(new Set([primaryRole, ...(user.roles || [])]));

    if (currentRoles.includes(targetRole)) {
      throw new AppError('أنت تمتلك هذا الحساب بالفعل', 409);
    }

    const updatedRoles = Array.from(new Set([...currentRoles, targetRole]));

    // Transaction to create profile, update user roles, and log audit
    await prisma.$transaction(async (tx) => {
      // Defensive backfill: ensure any OTHER role this user already owns
      // (currentRoles never includes targetRole here — checked above) has its
      // profile row too, in case an older signup path left a gap. The
      // newly-added targetRole itself keeps its own richer, metadata-aware
      // creation below (profileMetadata only applies to the role being
      // deliberately added right now, not to a defensive backfill).
      const identity: RoleInitializationIdentity = {
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        email: user.email,
        phoneNumber: user.phoneNumber,
        idNumber: user.idNumber,
        idExpiryDate: user.idExpiryDate,
        ibanNumber: user.ibanNumber,
        bankName: user.bankName,
        accountHolderName: user.accountHolderName,
        idDocumentUrl: user.idDocumentUrl,
        accountType: user.accountType
      };

      await createMissingRoleProfiles(tx, user.id, currentRoles, identity);

      // The newly-added targetRole itself keeps its own richer, metadata-aware
      // creation (profileMetadata only applies to the role being deliberately
      // added right now, not to the defensive backfill above) — routed
      // through the same canonical initializer as everywhere else so it gets
      // the same seeded display fields, real initial completion and (for
      // PROVIDER) ProviderGamification guarantees, without duplicating any
      // formula. extraFields carries addAccountType's own DTO-shaped
      // metadata field names (coName/specMain/portfolioBio/specExp) — mapped
      // to Prisma column names here, exactly as this function already did.
      if (targetRole === UserRole.PROVIDER) {
        await initializeRoleState(tx, user.id, UserRole.PROVIDER, identity, {
          companyName: profileMetadata?.coName || null,
          headline: profileMetadata?.specMain || 'مقدم خدمة',
          bio: profileMetadata?.portfolioBio || null,
          yearsOfExperience: profileMetadata?.specExp ? parseInt(profileMetadata.specExp, 10) || 1 : 1
        });
      } else if (targetRole === UserRole.CLIENT) {
        await initializeRoleState(tx, user.id, UserRole.CLIENT, identity, {
          companyName: profileMetadata?.coName || null,
          crNumber: profileMetadata?.coCrn || null,
          bio: profileMetadata?.portfolioBio || null
        });
      } else if (targetRole === UserRole.AFFILIATE) {
        await initializeRoleState(tx, user.id, UserRole.AFFILIATE, identity);
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          roles: updatedRoles,
          activeRole: targetRole
        }
      });

      await tx.accountAuditLog.create({
        data: {
          userId: user.id,
          category: 'ROLE_ADDITION',
          title: `إضافة حساب جديد (${targetRole})`,
          actionText: `تمت إضافة وتفعيل دور ${targetRole} بنجاح`,
          status: 'APPROVED',
          statusText: 'تم الاعتماد والتفعيل تلقائياً',
          eventType: 'ROLE_ADDED',
          source: 'USER',
          severity: 'INFO',
          summary: `تمت إضافة وتفعيل دور ${targetRole} بنجاح`,
          afterData: { role: targetRole },
          sessionId: auditContext?.sessionId,
          ipAddress: auditContext?.ipAddress,
          device: auditContext?.device,
          occurredAt: new Date()
        }
      });
    });

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new AppError('JWT_SECRET غير معرّف', 500);
    const token = jwt.sign(
      {
        userId: user.id,
        accountType: user.accountType,
        activeRole: targetRole,
        roles: updatedRoles
      },
      jwtSecret,
      { expiresIn: '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        accountType: user.accountType,
        activeRole: targetRole,
        roles: updatedRoles
      }
    };
  }

  /**
   * Switch user active role and return a new JWT token
   */
  public async switchActiveRole(userId: string, targetRole: UserRole, auditContext?: AuditContext) {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new AppError('حساب المستخدم غير موجود', 404);
    }

    const primaryRole = getRoleFromAccountType(user.accountType);
    const currentRoles: UserRole[] = Array.from(new Set([primaryRole, ...(user.roles || [])]));

    if (!currentRoles.includes(targetRole)) {
      throw new AppError('أنت لا تمتلك هذا الحساب، يرجى إضافته أولاً', 400);
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        roles: currentRoles,
        activeRole: targetRole
      }
    });

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new AppError('JWT_SECRET غير معرّف', 500);
    const token = jwt.sign(
      {
        userId: updatedUser.id,
        accountType: updatedUser.accountType,
        activeRole: targetRole,
        roles: currentRoles
      },
      jwtSecret,
      { expiresIn: '7d' }
    );

    await accountAuditLogService.record({ userId, eventType: 'ROLE_SWITCHED', category: 'SYSTEM_AUDIT', title: 'تبديل الحساب النشط', summary: `تم الانتقال إلى دور ${targetRole}`, source: 'USER', status: 'COMPLETED', after: { activeRole: targetRole }, context: auditContext });

    // Phase 3C: the switched-to role's own profile (+ ProviderGamification for
    // PROVIDER) is the source of truth for the response's display/progression
    // fields — a role switch must hand back a user shape that already reflects
    // the NEW activeRole, not the role that was just left. Only fetch the one
    // relation the target role actually needs.
    const relationSelect: Record<string, unknown> = {};
    // Explicit select (same deployment-safety reason as AFFILIATE below): only the fields
    // resolveActiveRoleDisplayFields() reads, so a database missing a newer ClientProfile column
    // (e.g. paypalPayoutEmail) can still switch to the CLIENT dashboard after add-account.
    if (targetRole === UserRole.CLIENT) {
      relationSelect.clientProfile = {
        select: { firstName: true, lastName: true, avatarUrl: true, completionPercentage: true, currentLevel: true, currentPoints: true, pointsToNextLevel: true }
      };
    }
    if (targetRole === UserRole.PROVIDER) { relationSelect.providerProfile = true; relationSelect.gamification = true; }
    // Deployment-safety fix: a bare `true` for a relation inside `select`
    // still fetches ALL of that related model's default scalars (select
    // only restricts the PARENT model — it doesn't cascade unless the
    // relation itself is given a nested select/select-object). AffiliateProfile
    // gained a `level` column whose migration has not been applied to
    // DEV/LIVE yet, so this would 500 a role switch to AFFILIATE. Only the
    // fields resolveActiveRoleDisplayFields() actually reads are selected.
    if (targetRole === UserRole.AFFILIATE) {
      relationSelect.affiliateProfile = {
        select: { firstName: true, lastName: true, avatarUrl: true, currentLevel: true, completionPercentage: true }
      };
    }

    const roleRelations = Object.keys(relationSelect).length > 0
      ? await prisma.user.findUnique({ where: { id: userId }, select: relationSelect as any })
      : null;

    const displayFields = resolveActiveRoleDisplayFields({
      activeRole: targetRole,
      legacy: {
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        avatarUrl: updatedUser.avatarUrl,
        profileCompletionPercent: updatedUser.profileCompletionPercent,
        currentLevel: updatedUser.currentLevel,
        currentPoints: updatedUser.currentPoints,
        pointsToNextLevel: updatedUser.pointsToNextLevel
      },
      clientProfile: (roleRelations as any)?.clientProfile,
      providerProfile: (roleRelations as any)?.providerProfile,
      providerGamification: (roleRelations as any)?.gamification,
      affiliateProfile: (roleRelations as any)?.affiliateProfile
    });

    return {
      token,
      user: {
        id: updatedUser.id,
        firstName: displayFields.firstName,
        lastName: displayFields.lastName,
        avatarUrl: displayFields.avatarUrl,
        profileCompletionPercent: displayFields.profileCompletionPercent,
        currentLevel: displayFields.currentLevel,
        currentPoints: displayFields.currentPoints,
        pointsToNextLevel: displayFields.pointsToNextLevel,
        email: updatedUser.email,
        accountType: updatedUser.accountType,
        activeRole: targetRole,
        roles: currentRoles
      }
    };
  }
}

export const accountManagementService = new AccountManagementService();
