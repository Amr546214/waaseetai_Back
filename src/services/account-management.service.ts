import jwt from 'jsonwebtoken';
import { UserRole, AccountType, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { generateReferralSlug } from '../utils/slug.util';
import { accountAuditLogService, AuditContext } from './account-logs.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';

/**
 * Helper to derive primary UserRole from AccountType enum
 */
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
 * Ensure every role in `roles` has its matching profile row for this user,
 * creating whichever bare row(s) are missing and leaving existing ones
 * untouched. This is the single source of truth for "which profile row(s)
 * should this user have" — used by email/password registration
 * (authRepository.createUserWithProfile), Google sign-up
 * (authService.googleAuth), addAccountType, the self-healing path in
 * getAvailableAccountTypes, and the scripts/backfill-role-profiles.ts script,
 * so none of them can diverge on this again.
 *
 * Idempotent and safe to call repeatedly / concurrently with itself: each
 * profile is checked with a findUnique before creating it, so calling this
 * again with roles that already have a row is a no-op for those roles.
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
  identity: { firstName: string; lastName: string }
): Promise<CreateMissingRoleProfilesResult> {
  const result: CreateMissingRoleProfilesResult = {
    clientCreated: false,
    providerCreated: false,
    affiliateCreated: false
  };

  if (roles.includes(UserRole.CLIENT)) {
    const existing = await tx.clientProfile.findUnique({ where: { userId } });
    if (!existing) {
      await tx.clientProfile.create({ data: { userId } });
      result.clientCreated = true;
    }
  }

  if (roles.includes(UserRole.PROVIDER)) {
    const existing = await tx.providerProfile.findUnique({ where: { userId } });
    if (!existing) {
      await tx.providerProfile.create({ data: { userId } });
      result.providerCreated = true;
    }
  }

  if (roles.includes(UserRole.AFFILIATE)) {
    const existing = await tx.affiliateProfile.findUnique({ where: { userId } });
    if (!existing) {
      const slug = generateReferralSlug(`${identity.firstName} ${identity.lastName}`, userId);
      await tx.affiliateProfile.create({ data: { userId, referralSlug: slug } });
      result.affiliateCreated = true;
    }
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
        roles: true,
        activeRole: true,
        accountType: true,
        clientProfile: { select: { id: true } },
        providerProfile: { select: { id: true } },
        affiliateProfile: { select: { id: true } }
      }
    });

    if (!user) {
      throw new AppError('حساب المستخدم غير موجود', 404);
    }

    const primaryRole = getRoleFromAccountType(user.accountType);
    let userRoles: UserRole[] = Array.from(new Set([primaryRole, ...(user.roles || [])]));
    let activeRole: UserRole = user.activeRole || primaryRole;

    // Self-healing check: If DB roles/activeRole was out of sync due to default schema values, persist correct values
    if (!user.roles || !user.roles.includes(primaryRole) || user.activeRole !== activeRole) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          roles: userRoles,
          activeRole: activeRole
        }
      });
    }

    // Self-healing also covers profile rows: an older signup path (or a
    // partial/failed transaction) may have left this user owning a role with
    // no matching profile row. Idempotent — a no-op for roles that already
    // have their profile.
    await createMissingRoleProfiles(prisma, userId, userRoles, {
      firstName: user.firstName,
      lastName: user.lastName
    });

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
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        clientProfile: true,
        providerProfile: true,
        affiliateProfile: true
      }
    });

    if (!user) {
      throw new AppError('حساب المستخدم غير موجود', 404);
    }

    const primaryRole = getRoleFromAccountType(user.accountType);
    const currentRoles: UserRole[] = Array.from(new Set([primaryRole, ...(user.roles || [])]));

    if (currentRoles.includes(targetRole)) {
      throw new AppError('أنت تمتلك هذا الحساب بالفعل', 400);
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
      await createMissingRoleProfiles(tx, user.id, currentRoles, {
        firstName: user.firstName,
        lastName: user.lastName
      });

      if (targetRole === UserRole.PROVIDER) {
        if (!user.providerProfile) {
          await tx.providerProfile.create({
            data: {
              userId: user.id,
              companyName: profileMetadata?.coName || null,
              headline: profileMetadata?.specMain || 'مقدم خدمة',
              bio: profileMetadata?.portfolioBio || null,
              yearsOfExperience: profileMetadata?.specExp ? parseInt(profileMetadata.specExp, 10) || 1 : 1
            }
          });
        }
      } else if (targetRole === UserRole.CLIENT) {
        if (!user.clientProfile) {
          await tx.clientProfile.create({
            data: {
              userId: user.id,
              companyName: profileMetadata?.coName || null,
              crNumber: profileMetadata?.coCrn || null,
              bio: profileMetadata?.portfolioBio || null
            }
          });
        }
      } else if (targetRole === UserRole.AFFILIATE) {
        if (!user.affiliateProfile) {
          const slug = generateReferralSlug(`${user.firstName} ${user.lastName}`, user.id);
          await tx.affiliateProfile.create({
            data: {
              userId: user.id,
              referralSlug: slug
            }
          });
        }
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
    const relationSelect: Record<string, boolean> = {};
    if (targetRole === UserRole.CLIENT) relationSelect.clientProfile = true;
    if (targetRole === UserRole.PROVIDER) { relationSelect.providerProfile = true; relationSelect.gamification = true; }
    if (targetRole === UserRole.AFFILIATE) relationSelect.affiliateProfile = true;

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
