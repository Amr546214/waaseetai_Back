import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { UpdateProfileDto } from '../dtos/profile.dto';
import { AppError } from '../utils/app-error';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';
import { parsePaypalPayoutEmail } from '../dtos/profile.dto';
import { computeClientCompletion, computeClientMissingItems } from '../utils/completion-calculators';
import { logger } from '../config/logger';
import { providerProfileService } from './provider-profile.service';
import { marketerProfileService } from './marketer-profile.service';
import { AFFILIATE_PROFILE_SAFE_SCALAR_SELECT } from '../utils/affiliate-profile-safe-select.util';

export class ProfileService {
  /**
   * Fetch a user's full integrated profile.
   *
   * Phase 3C: read-only. Display/progression fields (firstName, lastName,
   * avatarUrl, profileCompletionPercent, currentLevel, currentPoints,
   * pointsToNextLevel) are resolved from the user's CURRENTLY ACTIVE role
   * profile via resolveActiveRoleDisplayFields, falling back to the legacy
   * User columns when the role-specific value/profile is missing. This used
   * to branch on accountType.includes('CLIENT') (wrong for AFFILIATE users,
   * and wrong for any multi-role user whose activeRole differs from their
   * original signup accountType) and to write a freshly recalculated
   * profileCompletionPercent back to the User row as a side effect of this
   * GET — both are fixed here; this method no longer performs any writes.
   */
  public async getProfile(userId: string) {
    // Deployment-safety fix: `affiliateProfile` is narrowed to an explicit
    // nested select (a bare `true` inside `include` fetches ALL of
    // AffiliateProfile's default scalars, which would now include the
    // not-yet-migrated `level` column and 500 this endpoint for every
    // AFFILIATE-active user). `roleProfile` below is spread wholesale into
    // the API response (`...roleProfile`), so the full pre-existing scalar
    // shape is preserved via AFFILIATE_PROFILE_SAFE_SCALAR_SELECT — only
    // `level` is excluded. clientProfile/providerProfile/gamification are
    // untouched (different models, no schema/DB mismatch).
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        clientProfile: true,
        providerProfile: true,
        affiliateProfile: { select: AFFILIATE_PROFILE_SAFE_SCALAR_SELECT },
        gamification: true
      }
    });

    if (!user) {
      throw new AppError('تعذر العثور على حساب المستخدم', 404);
    }

    // Fetch last 3 change requests for the historical trace
    // const latestHistory = await prisma.profileChangeRequest.findMany({
    //   where: { userId },
    //   orderBy: { createdAt: 'desc' },
    //   take: 3
    // });
    const latestHistory: any[] = [];

    // Format output
    const { password, ...safeUser } = user;

    // Role-specific tab data (companyName, bio, KYC fields, etc.) still comes
    // from whichever profile matches the CURRENTLY ACTIVE role — not
    // accountType, which only reflects how the identity first registered.
    const roleProfile =
      user.activeRole === UserRole.CLIENT ? user.clientProfile :
      user.activeRole === UserRole.PROVIDER ? user.providerProfile :
      user.activeRole === UserRole.AFFILIATE ? user.affiliateProfile :
      null;

    const resolvedDisplayFields = resolveActiveRoleDisplayFields({
      activeRole: user.activeRole,
      legacy: {
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        profileCompletionPercent: user.profileCompletionPercent,
        currentLevel: user.currentLevel,
        currentPoints: user.currentPoints,
        pointsToNextLevel: user.pointsToNextLevel
      },
      clientProfile: user.clientProfile,
      providerProfile: user.providerProfile,
      providerGamification: user.gamification,
      affiliateProfile: user.affiliateProfile
    });

    const currentProfileData: Record<string, unknown> = {
      ...safeUser,
      ...roleProfile,
      ...resolvedDisplayFields
    };

    // CLIENT: the completion is recomputed from the rows just read (so a stored value that predates the current formula is
    // healed on the next read) and returned with what is still missing. The stored column is synced when it differs (best
    // effort, never fails the read).
    if (user.activeRole === UserRole.CLIENT && user.clientProfile) {
      const input = { user, clientProfile: user.clientProfile };
      const completion = computeClientCompletion(input);
      const missingItems = computeClientMissingItems(input);
      if (user.clientProfile.completionPercentage !== completion) {
        try {
          await prisma.clientProfile.update({ where: { userId }, data: { completionPercentage: completion }, select: { id: true } });
        } catch (error) {
          logger.error(`[ProfileService] Failed to sync stored client completion (userId=${userId})`, error);
        }
      }
      currentProfileData.profileCompletionPercent = completion;
      currentProfileData.completionPercentage = completion;
      currentProfileData.missingItems = missingItems;
    }

    return {
      currentProfileData,
      latestHistory
    };
  }

  /**
   * Update User fields and nested profile metadata using $transaction.
   *
   * Phase 3D.1: firstName/lastName/avatarUrl are role-specific display
   * fields — they are written to whichever profile matches the caller's
   * CURRENTLY ACTIVE role (ClientProfile/ProviderProfile/AffiliateProfile),
   * never to the legacy User row, so editing one persona's name/avatar can
   * never change another persona's. The target is chosen by `activeRole`
   * (same source Phase 3C's reads already use), NOT by accountType — the
   * original signup type never determines where a display edit lands.
   * phoneNumber remains on User: it is identity-level, not role-specific.
   */
  public async updateProfile(userId: string, activeRole: UserRole, dto: UpdateProfileDto) {
    const {
      firstName,
      lastName,
      phoneNumber,
      avatarUrl,
      ...profileData
    } = dto;
	const storedAvatarUrl = avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');

    const displayFields: Record<string, unknown> = {};
    if (firstName !== undefined) displayFields.firstName = firstName;
    if (lastName !== undefined) displayFields.lastName = lastName;
    if (avatarUrl !== undefined) displayFields.avatarUrl = storedAvatarUrl;

    return await prisma.$transaction(async (tx) => {
      // 1. Update Core User fields if provided (identity-level only —
      // firstName/lastName/avatarUrl are handled in step 2 below).
      const userUpdateData: any = {};
      if (phoneNumber !== undefined) userUpdateData.phoneNumber = phoneNumber;

      // Upgrade status if currently pending
      const currentUser = await tx.user.findUnique({ where: { id: userId } });
      if (currentUser?.status === UserStatus.PENDING_VERIFICATION) {
        userUpdateData.status = UserStatus.ACTIVE;
      }

      let updatedUser = currentUser;
      if (Object.keys(userUpdateData).length > 0) {
        updatedUser = await tx.user.update({
          where: { id: userId },
          data: userUpdateData
        });
      }

      // 2. Update the active role's profile data, merged with any display
      // fields from this same request. Each branch strips fields that don't
      // exist on that model — same pragmatic pattern already used for the
      // PROVIDER branch below, extended to AFFILIATE.
      let profileResult = null;
      const hasProfileData = Object.keys(profileData).length > 0;
      const hasDisplayFields = Object.keys(displayFields).length > 0;
      if (hasProfileData || hasDisplayFields) {
        if (activeRole === UserRole.CLIENT) {
          const clientData = { ...(profileData as any), ...displayFields };
          profileResult = await tx.clientProfile.upsert({
            where: { userId },
            create: { userId, ...clientData },
            update: clientData
          });

          // Phase 3D.2A: recalculate ClientProfile.completionPercentage from
          // the FINAL post-write state (the upsert's own return value already
          // reflects every field just written, plus whatever already existed
          // on the row) — never from the partial `clientData` being sent in
          // this request, which would wrongly score already-set fields this
          // request didn't touch as "missing". Scoped to CLIENT only — never
          // written for PROVIDER/AFFILIATE updates, and never mirrored to
          // User.profileCompletionPercent.
          const clientCompletion = computeClientCompletion({ user: updatedUser || {}, clientProfile: profileResult });
          profileResult = await tx.clientProfile.update({
            where: { userId },
            data: { completionPercentage: clientCompletion }
          });
        } else if (activeRole === UserRole.AFFILIATE) {
          // AffiliateProfile only has `bio` in common with the fields this
          // endpoint's DTO can carry — strip the rest (company/provider-only
          // fields) exactly like the PROVIDER branch already strips its own
          // incompatible fields below, so an AFFILIATE-active submission
          // can't throw on an unknown-column error.
          const affiliateData: any = { ...(profileData as any) };
          delete affiliateData.companyName;
          delete affiliateData.companySize;
          delete affiliateData.industry;
          delete affiliateData.website;
          delete affiliateData.skills;
          delete affiliateData.hourlyRate;
          delete affiliateData.yearsOfExperience;
          delete affiliateData.headline;
          delete affiliateData.location;
          delete affiliateData.city;
          delete affiliateData.country;
          delete affiliateData.githubUrl;
          delete affiliateData.linkedinUrl;
          delete affiliateData.websiteUrl;
          // Payout P2-A: paypalPayoutEmail is PROVIDER-only (see
          // ProviderProfile.paypalPayoutEmail) — AffiliateProfile has no such
          // column, so this must be stripped exactly like the other
          // provider-only fields above, or an AFFILIATE-active submission
          // that includes it (even '') would throw an unknown-column error.
          delete affiliateData.paypalPayoutEmail;
          Object.assign(affiliateData, displayFields);

          // Explicit select — deployment-safety fix. `profileResult` is
          // forwarded as-is into this method's return value, which the
          // controller returns directly as the API response's `data.profile`
          // — so the full pre-existing scalar shape is preserved via
          // AFFILIATE_PROFILE_SAFE_SCALAR_SELECT (everything except the new,
          // not-yet-migrated `level` column).
          profileResult = await tx.affiliateProfile.upsert({
            where: { userId },
            create: { userId, ...affiliateData },
            update: affiliateData,
            select: AFFILIATE_PROFILE_SAFE_SCALAR_SELECT
          });
          // avatar / bio written here are completion inputs: recompute from this transaction's own writes.
          await marketerProfileService.recalculateCompletion(userId, tx);
        } else if (activeRole === UserRole.PROVIDER) {
          // Clean undefined/incompatible properties for Provider.
          const providerData: any = { ...(profileData as any) };
          delete providerData.companySize;
          delete providerData.industry;
          delete providerData.website;
          Object.assign(providerData, displayFields);

          profileResult = await tx.providerProfile.upsert({
            where: { userId },
            create: { userId, ...providerData },
            update: providerData
          });
          // PayPal (and the other scored fields) saved through this endpoint must move the stored percentage too.
          await providerProfileService.recalculateProviderCompletion(userId, tx);
        } else {
          // ADMIN/SUPER_ADMIN or any future role have no role-specific
          // profile concept today — never silently fall through and treat
          // an unsupported role as PROVIDER (or any other profile). Fail
          // safely instead of guessing a write target.
          throw new AppError(`تحديث الملف الشخصي غير مدعوم لهذا الدور: ${activeRole}`, 400);
        }
      }

      return {
        user: updatedUser,
        profile: profileResult
      };
    });
  }

  /**
   * Update Profile by Tab Name with moderation flow.
   *
   * Phase 3D.1: the 'basics'/'contact' branch used to write the ENTIRE
   * request body (minus email/phoneNumber) straight onto User, completely
   * unvalidated — any Prisma User column name in the body would be written.
   * Replaced with an explicit allowlist of the real identity-level User
   * columns this tab may legitimately touch (matching updateContactSchema's
   * fields — src/dtos/profile-tab.dto.ts — the only real schema whose fields
   * map onto genuine User columns beyond email/phoneNumber, which were
   * already special-cased). Everything else in the body is silently dropped.
   * firstName/lastName/avatarUrl are pulled out separately and routed to the
   * caller's active-role profile via upsertActiveRoleDisplayFields, same
   * target as updateProfile()/getProfile() — never to User.
   */
  public async updateTab(userId: string, tabName: string, data: any, activeRole: UserRole) {
    if (tabName === 'basics' || tabName === 'contact') {
      const { email, phoneNumber, firstName, lastName, avatarUrl, ...rest } = data;

      // Re-verified against the current User model (prisma/schema.prisma):
      // User has NO `country` column at all (only ClientProfile/
      // ProviderProfile do) — updateContactSchema lists `country` but it does
      // not correspond to a real User field, so it is deliberately excluded
      // here. Including it would make prisma.user.update throw on an unknown
      // argument the first time a caller sent it.
      const ALLOWED_USER_FIELDS = ['alternativePhone', 'address', 'region', 'city'] as const;
      const safeUserData: Record<string, unknown> = {};
      for (const field of ALLOWED_USER_FIELDS) {
        if (rest[field] !== undefined) safeUserData[field] = rest[field];
      }

      const displayFields: { firstName?: string; lastName?: string; avatarUrl?: string | null } = {};
      if (firstName !== undefined) displayFields.firstName = firstName;
      if (lastName !== undefined) displayFields.lastName = lastName;
      if (avatarUrl !== undefined) {
        displayFields.avatarUrl = avatarUrl === '' ? '' : await storeDataUriIfNeeded(avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');
      }

      // Both writes together, atomically — a partial failure must not leave
      // the identity-level update applied without the display-field one (or
      // vice versa).
      await prisma.$transaction(async (tx) => {
        if (Object.keys(safeUserData).length > 0) {
          await tx.user.update({ where: { id: userId }, data: safeUserData });
        }
        const displayResult = await this.upsertActiveRoleDisplayFields(tx, userId, activeRole, displayFields);

        // Phase 3D.2A: firstName/lastName/avatarUrl are the ONLY fields this
        // tab can write that the CLIENT completion formula reads (the
        // allowlisted identity fields above — alternativePhone/address/
        // region/city — aren't formula inputs), so only recalculate when a
        // display field actually changed for a CLIENT-active caller,
        // computed from the FINAL post-write state. Never for PROVIDER/
        // AFFILIATE, never mirrored to User.
        // AFFILIATE: the avatar written by this tab is a completion input too.
        if (activeRole === UserRole.AFFILIATE && displayResult) {
          await marketerProfileService.recalculateCompletion(userId, tx);
        }
        if (activeRole === UserRole.CLIENT && displayResult) {
          const finalUser = await tx.user.findUnique({ where: { id: userId } });
          const clientCompletion = computeClientCompletion({ user: finalUser || {}, clientProfile: displayResult as any });
          await tx.clientProfile.update({ where: { userId }, data: { completionPercentage: clientCompletion } });
        }
      });

      // If sensitive data changed, trigger OTP/Moderation flow
      if (email || phoneNumber) {
        // Mock OTP creation for now
        // await prisma.profileChangeRequest.create({
        //   data: {
        //     userId,
        //     tabName: 'CONTACT_UPDATE',
        //     requestedChanges: { email, phoneNumber }
        //   }
        // });
      }
      return { message: 'تم التحديث. التعديلات الحساسة تتطلب التحقق.' };
    }

    // CLIENT PayPal payout: saved directly (like the Provider PayPal email) to
    // ClientProfile.paypalPayoutEmail only. It is a payout destination, not a
    // bank/identity change, so it does not flip the account to
    // PENDING_VERIFICATION and never touches the bank columns.
    if (tabName === 'banking' && activeRole === UserRole.CLIENT && data && data.paypalPayoutEmail !== undefined) {
      const raw = data.paypalPayoutEmail;
      const clear = raw === null || raw === '';
      const email = clear ? null : parsePaypalPayoutEmail(raw);
      if (!clear && !email) throw new AppError('بريد PayPal غير صحيح', 400);

      await prisma.$transaction(async (tx) => {
        // Keep paymentType consistent with the email: 'paypal' when set; when
        // cleared, drop a 'paypal' marker (a legacy 'bank'/'wallet' value stays).
        const existing = await tx.clientProfile.findUnique({ where: { userId }, select: { paymentType: true } });
        const paymentTypeUpdate = email
          ? { paymentType: 'paypal' }
          : existing?.paymentType === 'paypal' ? { paymentType: null } : {};
        const profile = await tx.clientProfile.upsert({
          where: { userId },
          create: { userId, paypalPayoutEmail: email, ...(email ? { paymentType: 'paypal' } : {}) },
          update: { paypalPayoutEmail: email, ...paymentTypeUpdate }
        });
        const user = await tx.user.findUnique({ where: { id: userId } });
        const completion = computeClientCompletion({ user: user || {}, clientProfile: profile as any });
        await tx.clientProfile.update({ where: { userId }, data: { completionPercentage: completion } });
      });
      return { message: 'تم حفظ بريد PayPal بنجاح' };
    }

    if (tabName === 'identity' || tabName === 'banking') {
      // Create a moderation request for sensitive data
      // await prisma.profileChangeRequest.create({
      //   data: {
      //     userId,
      //     tabName: tabName.toUpperCase() + '_UPDATE',
      //     requestedChanges: data
      //   }
      // });
      
      // Flag user as pending review
      await prisma.user.update({
        where: { id: userId },
        data: { status: UserStatus.PENDING_VERIFICATION }
      });

      return { message: 'تم إرسال طلب التعديل للمراجعة. حالة الحساب الآن: قيد التحقق' };
    }

    throw new AppError('تبويب غير معروف', 400);
  }

  /**
   * Phase 3D.1: writes firstName/lastName/avatarUrl to whichever profile
   * matches the caller's CURRENTLY ACTIVE role — never to User. Shared by
   * updateTab() (display fields only) so it targets the same table the same
   * way updateProfile()/getProfile() already do. All three fields exist on
   * every one of ClientProfile/ProviderProfile/AffiliateProfile (Phase 3A),
   * so no per-model field-stripping is needed here.
   *
   * Explicit role branching only — CLIENT/PROVIDER/AFFILIATE are the only
   * roles with a profile-display concept today. ADMIN/SUPER_ADMIN or any
   * future role must never silently fall through to one of these three
   * tables; they fail safely instead (matches updateProfile()'s branching).
   */
  private async upsertActiveRoleDisplayFields(
    tx: Prisma.TransactionClient,
    userId: string,
    activeRole: UserRole,
    fields: { firstName?: string; lastName?: string; avatarUrl?: string | null }
  ) {
    if (Object.keys(fields).length === 0) return null;

    if (activeRole === UserRole.CLIENT) {
      return tx.clientProfile.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
    }
    if (activeRole === UserRole.PROVIDER) {
      return tx.providerProfile.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
    }
    if (activeRole === UserRole.AFFILIATE) {
      // Explicit select — deployment-safety fix. Unlike the CLIENT branch
      // above (whose return value updateTab() reads for completion
      // recalculation), this AFFILIATE branch's return value is never read
      // by any caller (updateTab() only inspects it for `activeRole ===
      // CLIENT`), so a minimal select is safe here without any response-shape
      // change.
      return tx.affiliateProfile.upsert({ where: { userId }, create: { userId, ...fields }, update: fields, select: { id: true } });
    }

    throw new AppError(`تحديث الملف الشخصي غير مدعوم لهذا الدور: ${activeRole}`, 400);
  }

  /**
   * Get pending change requests for the user
   */
  public async getMyChangeRequests(userId: string) {
    // const requests = await prisma.profileChangeRequest.findMany({
    //   where: { userId },
    //   orderBy: { createdAt: 'desc' }
    // });
    return [];
  }

  /**
   * Admin Simulation: Process a pending change request
   */
  public async processChangeRequest(requestId: string, status: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
    throw new AppError('Not implemented for generic profile yet', 500);
  }
}

export const profileService = new ProfileService();
