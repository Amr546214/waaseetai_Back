import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { UpdateProfileDto } from '../dtos/profile.dto';
import { AppError } from '../utils/app-error';
import { PHONE_CHANGE_REQUIRED_MESSAGE } from '../utils/phone-change-messages';
import { PAYPAL_EMAIL_OTP_REQUIRED_MESSAGE } from '../utils/paypal-email-messages';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';
import { parsePaypalPayoutEmail } from '../dtos/profile.dto';
import { computeClientCompletion, computeClientMissingItems } from '../utils/completion-calculators';
import { logger } from '../config/logger';
import { providerProfileService } from './provider-profile.service';
import { withoutLegacyAffiliateBankFields } from '../utils/affiliate-payout';
import { withoutLegacyProviderBankFields } from '../utils/provider-payout';
import { marketerProfileService } from './marketer-profile.service';
import { AFFILIATE_PROFILE_SAFE_SCALAR_SELECT } from '../utils/affiliate-profile-safe-select.util';
import { withoutLegacyPayoutFields } from '../utils/client-payout-fields';
import { CLIENT_IDENTITY_REQUEST_CATEGORY as CLIENT_IDENTITY_CATEGORY, CLIENT_BASIC_INFO_REQUEST_CATEGORY } from '../utils/profile-request-categories';

const maskId = (value: string) => (value.length > 4 ? `${'*'.repeat(value.length - 4)}${value.slice(-4)}` : value);

/** The only fields PUT /profiles/update may write on a ClientProfile (display fields firstName/lastName/avatarUrl are handled separately). */
const CLIENT_PROFILE_FIELDS = ['companyName', 'companySize', 'industry', 'website', 'bio', 'interests', 'portfolioUrl', 'linkedinUrl', 'personalWebsiteUrl', 'interfaceLanguage', 'timezone'] as const;
const CLIENT_NULLABLE_LINKS = new Set(['portfolioUrl', 'linkedinUrl', 'personalWebsiteUrl']);

function pickClientProfileFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CLIENT_PROFILE_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;                       // not sent: keep what is stored
    if (key === 'interests') { if (Array.isArray(value)) out.interests = [...new Set(value.map(v => String(v).trim()).filter(Boolean))]; continue; }
    if (value === null && key !== 'bio') continue;           // null = "not provided" for everything except the bio (cleared with '')
    out[key] = CLIENT_NULLABLE_LINKS.has(key) && value === '' ? null : value;
  }
  return out;
}

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
      ...(user.activeRole === UserRole.CLIENT ? withoutLegacyPayoutFields(roleProfile as any) : user.activeRole === UserRole.AFFILIATE ? withoutLegacyAffiliateBankFields(roleProfile as any) : user.activeRole === UserRole.PROVIDER ? withoutLegacyProviderBankFields(roleProfile as any) : roleProfile),
      ...resolvedDisplayFields
    };

    // CLIENT: the contact tab saves the city on User while the setup / identity tabs save it on ClientProfile; a null ClientProfile
    // city must not hide the saved User city (it used to reload empty after a successful save).
    if (user.activeRole === UserRole.CLIENT && !currentProfileData.city && user.city) currentProfileData.city = user.city;

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

      // A profile save never changes User.status: activation is owned by OTP verification / admin review.
      const currentUser = await tx.user.findUnique({ where: { id: userId } });

      // The phone number is changed only through the email-OTP flow (POST /profiles/phone/change/*). An unchanged number is ignored; a
      // different one is refused, and '' / null never erase it.
      if (phoneNumber && phoneNumber !== currentUser?.phoneNumber) throw new AppError(PHONE_CHANGE_REQUIRED_MESSAGE, 400);

      let updatedUser = currentUser;
      if (Object.keys(userUpdateData).length > 0) {
        try {
          updatedUser = await tx.user.update({
            where: { id: userId },
            data: userUpdateData
          });
        } catch (error) {
          // Unique phone number: 409 with a generic message that does not reveal whether the number belongs to another account.
          if ((error as { code?: string })?.code === 'P2002') throw new AppError('تعذر حفظ رقم الجوال، تأكد من الرقم أو جرّب رقمًا آخر', 409);
          throw error;
        }
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
          // Explicit allow-list (a provider-only field in the body must never reach the ClientProfile upsert: unknown column -> 500).
          const clientData: Record<string, unknown> = { ...pickClientProfileFields(profileData as Record<string, unknown>), ...displayFields };
          if (Object.keys(clientData).length === 0) return { user: updatedUser, profile: profileResult };
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
          // The PayPal payout email is changed only through the email-OTP flow (POST /profiles/paypal-email/change/*): an unchanged value is
          // ignored, any different one (including clearing it) is refused.
          if (providerData.paypalPayoutEmail !== undefined) {
            const requestedPaypal = providerData.paypalPayoutEmail ? String(providerData.paypalPayoutEmail).trim().toLowerCase() : null;
            const storedPaypal = (await tx.providerProfile.findUnique({ where: { userId }, select: { paypalPayoutEmail: true } }))?.paypalPayoutEmail?.trim().toLowerCase() || null;
            if (requestedPaypal !== storedPaypal) throw new AppError(PAYPAL_EMAIL_OTP_REQUIRED_MESSAGE, 400);
            delete providerData.paypalPayoutEmail;
          }
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
        profile: activeRole === UserRole.AFFILIATE ? withoutLegacyAffiliateBankFields(profileResult as any) : activeRole === UserRole.PROVIDER ? withoutLegacyProviderBankFields(profileResult as any) : profileResult
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
      // A CLIENT's name is a governed field: it is never written here. A change creates a modification request (category
      // CLIENT_BASIC_INFO) that an admin approves or rejects; the stored name changes only on approval.
      let nameRequest: { id: string; status: string } | null = null;
      if (activeRole === UserRole.CLIENT && (firstName !== undefined || lastName !== undefined)) {
        nameRequest = await this.requestClientNameChange(userId, firstName, lastName);
      } else {
        if (firstName !== undefined) displayFields.firstName = firstName;
        if (lastName !== undefined) displayFields.lastName = lastName;
      }
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
        if (activeRole === UserRole.PROVIDER && displayResult) {
          // avatar is a provider completion input (10 points): the stored percentage follows the change
          await providerProfileService.recalculateProviderCompletion(userId, tx);
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
      if (nameRequest) {
        return { message: 'تم إرسال طلب تعديل البيانات الأساسية للمراجعة', isPendingRequest: true, requestId: nameRequest.id, status: nameRequest.status };
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

    if (tabName === 'identity') {
      return this.updateClientIdentity(userId, data, activeRole);
    }

    if (tabName === 'banking') {
      // Only the PayPal payout email is editable for a client (handled above). Bank / wallet / IBAN are not supported: refuse
      // instead of pretending a review request was sent (and never flag the account as PENDING_VERIFICATION).
      throw new AppError('تعديل بيانات البنك أو المحفظة غير مدعوم حاليًا. يمكنك تحديث بريد PayPal فقط.', 400);
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
   * A client's first/last name change -> one modification request (PENDING_HUMAN_REVIEW) with the old and the new full name. Nothing is
   * written to the profile here. Returns null when the submitted name equals the current one (nothing to review). A second request
   * while one is pending is refused with 409. Applied only by an admin approval (ProviderProfileService.reviewSensitiveChange).
   */
  private async requestClientNameChange(userId: string, firstNameIn: unknown, lastNameIn: unknown): Promise<{ id: string; status: string } | null> {
    const [profile, user] = await Promise.all([
      prisma.clientProfile.findUnique({ where: { userId }, select: { firstName: true, lastName: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } })
    ]);
    const currentFirst = (profile?.firstName ?? user?.firstName ?? '').trim();
    const currentLast = (profile?.lastName ?? user?.lastName ?? '').trim();
    const nextFirst = firstNameIn === undefined ? currentFirst : String(firstNameIn ?? '').trim();
    const nextLast = lastNameIn === undefined ? currentLast : String(lastNameIn ?? '').trim();
    if (nextFirst.length < 2 || nextLast.length < 2) throw new AppError('الاسم الأول واسم العائلة يجب أن يكون كل منهما حرفين على الأقل', 400);
    if (nextFirst.length > 50 || nextLast.length > 50) throw new AppError('الاسم طويل جدًا', 400);
    if (nextFirst === currentFirst && nextLast === currentLast) return null;

    const existing = await prisma.profileModificationRequest.findFirst({
      where: { providerId: userId, category: CLIENT_BASIC_INFO_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' },
      select: { id: true }
    });
    if (existing) throw new AppError('لديك طلب تعديل للبيانات الأساسية قيد المراجعة بالفعل', 409);

    return prisma.profileModificationRequest.create({
      data: {
        providerId: userId,
        category: CLIENT_BASIC_INFO_REQUEST_CATEGORY,
        fieldName: 'FULL_NAME',
        fieldLabel: 'الاسم',
        currentValue: `${currentFirst} ${currentLast}`.trim() || null,
        requestedValue: `${nextFirst} ${nextLast}`,
        status: 'PENDING_HUMAN_REVIEW',
        requiresOtp: false,
        metadata: { changes: { firstName: nextFirst, lastName: nextLast }, requiresHumanReview: true } as any
      },
      select: { id: true, status: true }
    });
  }

  /**
   * CLIENT identity tab. country / city are plain profile data and save immediately. The national id / iqama number is a governed
   * field: it never changes here — a modification request (category CLIENT_IDENTITY) is recorded for an admin to approve or
   * reject, and the stored value changes only when it is approved (ProviderProfileService.reviewSensitiveChange). Fields the
   * database has no column for (nationality, id expiry date) are refused with a clear error, never silently dropped.
   */
  private async updateClientIdentity(userId: string, data: any, activeRole: UserRole) {
    if (activeRole !== UserRole.CLIENT) {
      throw new AppError('تعديل الهوية من هذه الصفحة متاح لحساب طالب الخدمة فقط', 400);
    }
    const input = data || {};
    for (const unsupported of ['nationality', 'idExpiryDate'] as const) {
      if (input[unsupported] !== undefined && String(input[unsupported]).trim() !== '') {
        throw new AppError('هذا الحقل غير مدعوم حاليًا ولا يمكن حفظه', 400);
      }
    }

    const profile = await prisma.clientProfile.findUnique({ where: { userId }, select: { idNumber: true, country: true, city: true } });
    const placeUpdate: { country?: string; city?: string } = {};
    if (input.country !== undefined && String(input.country).trim() !== '' && String(input.country).trim() !== profile?.country) placeUpdate.country = String(input.country).trim();
    if (input.city !== undefined && String(input.city).trim() !== '' && String(input.city).trim() !== profile?.city) placeUpdate.city = String(input.city).trim();

    const requestedId = input.idNumber === undefined ? '' : String(input.idNumber).trim();
    if (requestedId && !/^[12]\d{9}$/.test(requestedId)) {
      throw new AppError('رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2', 400);
    }
    const idChanged = !!requestedId && requestedId !== (profile?.idNumber || '');
    if (!idChanged && Object.keys(placeUpdate).length === 0) {
      throw new AppError('لا توجد تغييرات للحفظ', 400);
    }

    let pendingRequest: { id: string; status: string } | null = null;
    if (idChanged) {
      const existing = await prisma.profileModificationRequest.findFirst({
        where: { providerId: userId, category: CLIENT_IDENTITY_CATEGORY, status: { in: ['PENDING_HUMAN_REVIEW'] } },
        select: { id: true }
      });
      if (existing) throw new AppError('لديك طلب تعديل لرقم الهوية قيد المراجعة بالفعل', 409);
    }

    // both writes together: a failure must not leave the place saved while the request is lost (or the other way round)
    await prisma.$transaction(async (tx) => {
      if (Object.keys(placeUpdate).length > 0) {
        await tx.clientProfile.upsert({ where: { userId }, create: { userId, ...placeUpdate }, update: placeUpdate });
      }
      if (idChanged) {
        const created = await tx.profileModificationRequest.create({
          data: {
            providerId: userId,
            category: CLIENT_IDENTITY_CATEGORY,
            fieldName: 'NATIONAL_ID',
            fieldLabel: 'رقم الهوية / الإقامة',
            currentValue: profile?.idNumber ? maskId(profile.idNumber) : null,
            requestedValue: maskId(requestedId),
            status: 'PENDING_HUMAN_REVIEW',
            requiresOtp: false,
            metadata: { changes: { idNumber: requestedId }, requiresHumanReview: true } as any
          },
          select: { id: true, status: true }
        });
        pendingRequest = created;
      }
    });

    if (pendingRequest) {
      return {
        message: Object.keys(placeUpdate).length > 0
          ? 'تم حفظ الدولة والمدينة، وأُرسل طلب تعديل رقم الهوية للمراجعة'
          : 'تم إرسال طلب تعديل رقم الهوية للمراجعة',
        isPendingRequest: true,
        requestId: (pendingRequest as { id: string }).id,
        status: (pendingRequest as { status: string }).status
      };
    }
    return { message: 'تم حفظ الدولة والمدينة بنجاح', isPendingRequest: false };
  }

  /**
   * The signed-in client's own modification requests (newest first), in the shape the "طلبات تعديل الملف" page reads. The stored
   * metadata (it holds the real, unmasked values) is never returned.
   */
  public async getMyChangeRequests(userId: string) {
    const rows = await prisma.profileModificationRequest.findMany({
      where: { providerId: userId, category: { startsWith: 'CLIENT_' } },
      orderBy: { createdAt: 'desc' }
    });
    return rows.map(({ metadata: _metadata, ...safe }) => safe);
  }

  /** The client withdraws one of their own requests while it still waits for review. */
  public async cancelMyChangeRequest(userId: string, requestId: string) {
    const claimed = await prisma.profileModificationRequest.updateMany({
      where: { id: requestId, providerId: userId, category: { startsWith: 'CLIENT_' }, status: 'PENDING_HUMAN_REVIEW' },
      data: { status: 'CANCELLED' }
    });
    if (!claimed.count) {
      const exists = await prisma.profileModificationRequest.findFirst({ where: { id: requestId, providerId: userId, category: { startsWith: 'CLIENT_' } }, select: { status: true } });
      if (!exists) throw new AppError('الطلب غير موجود', 404);
      throw new AppError('لا يمكن سحب هذا الطلب لأنه لم يعد قيد المراجعة', 409);
    }
    return { id: requestId, status: 'CANCELLED' };
  }

  /**
   * Admin Simulation: Process a pending change request
   */
  public async processChangeRequest(requestId: string, status: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
    throw new AppError('Not implemented for generic profile yet', 500);
  }
}

export const profileService = new ProfileService();
