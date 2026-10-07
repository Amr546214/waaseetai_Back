import { UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { ProfileSetupDto } from '../dtos/profile-setup.dto';
import { storeDataUriIfNeeded, storeKycFileIfNeeded } from '../utils/cloudinary-storage';
import { AppError } from '../utils/app-error';
import { assertKycFileValues } from '../utils/kyc-value-guard';
import { assertVerifiedIdentityUnchanged, identitySubmissionChanged } from '../utils/kyc-identity-guard';
import { onboardingService } from './onboarding.service';
import { computeClientCompletion, computeProviderCompletion } from '../utils/completion-calculators';

export class ProfileSetupService {
  /**
   * Phase 3D.2A: target role resolved from activeRole, not accountType
   * (consistent with Phase 3D.1's display-write fix — the original signup
   * type never decides where a setup submission lands for a multi-role
   * user). The old unconditional `User.profileCompletionPercent = 100`
   * hardcode is gone: CLIENT/PROVIDER now get a real, calculated score
   * written to their OWN profile table, using the exact same calculators
   * used everywhere else in Phase 3D.2A — no new formula.
   *
   * AFFILIATE (or any other role) is rejected outright: this endpoint's
   * setup fields (bio/companyName/industry for CLIENT, bio/skills/
   * hourlyRate for PROVIDER) have no AFFILIATE-shaped equivalent here, and
   * it must not silently write a meaningless User completion value or fall
   * through to the PROVIDER branch. AFFILIATE has its own dedicated setup
   * surface (marketer-profile.service.ts), untouched by this change.
   *
   * avatarUrl's write target (User, not the role profile) is intentionally
   * UNCHANGED here — that's a Phase 3D.1-shaped display-field concern, out
   * of scope for this completion-focused phase.
   */
  public async saveProfileSetup(userId: string, activeRole: UserRole, dto: ProfileSetupDto) {
    if (activeRole !== UserRole.CLIENT && activeRole !== UserRole.PROVIDER) {
      throw new AppError('إعداد الملف الشخصي عبر هذا المسار غير مدعوم لهذا الدور', 400);
    }

    // Same identity handling as the main wizards (provider/client profile setup): a VERIFIED identity is frozen (409), KYC files are validated
    // and stored PRIVATE, and an unchanged re-save never re-opens a review.
    const profileModel: any = activeRole === UserRole.PROVIDER ? prisma.providerProfile : prisma.clientProfile;
    const storedIdentity = await profileModel.findUnique({ where: { userId }, select: { idNumber: true, dob: true, kycStatus: true } });
    assertVerifiedIdentityUnchanged(storedIdentity, { idNumber: dto.idNumber });
    assertKycFileValues([dto.frontId, dto.backId, dto.supportingDocs], userId);
    const folder = activeRole === UserRole.PROVIDER ? 'providers' : 'clients';
    const [frontIdUrl, backIdUrl, supportingDocsUrl] = await Promise.all([
      storeKycFileIfNeeded(dto.frontId, `waseetai/${folder}/${userId}/identity`, 'front-id'),
      storeKycFileIfNeeded(dto.backId, `waseetai/${folder}/${userId}/identity`, 'back-id'),
      storeKycFileIfNeeded(dto.supportingDocs, `waseetai/${folder}/${userId}/documents`, 'supporting-document')
    ]);
    // Skills are resolved against the skills catalogue exactly like the provider wizard (never written as raw strings, never upserted).
    let skillConnections: { id: string }[] | undefined;
    if (activeRole === UserRole.PROVIDER && dto.skills) {
      const names = [...new Set(dto.skills)];
      const rows = await prisma.skill.findMany({ where: { name: { in: names } }, select: { id: true, name: true } });
      if (rows.length !== names.length) throw new AppError('اختر مهارات موجودة في دليل المهارات؛ لم يتم حفظ البيانات.', 400);
      skillConnections = rows.map(({ id }) => ({ id }));
    }
    const avatarUrl = dto.avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(dto.avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');
    // Role-profile columns, identical to the main wizards: empty = keep what is stored (a stored private document is never wiped by a re-save).
    const identityAndBankData = () => ({
      ...(dto.idNumber ? { idNumber: dto.idNumber } : {}),
      ...(dto.country ? { country: dto.country } : {}),
      ...(dto.city ? { city: dto.city } : {}),
      ...(frontIdUrl ? { frontIdUrl } : {}),
      ...(backIdUrl ? { backIdUrl } : {}),
      ...(supportingDocsUrl ? { supportingDocsUrl } : {}),
      ...(dto.ibanNumber ? { iban: dto.ibanNumber } : {}),
      ...(dto.bankName ? { bankName: dto.bankName } : {}),
      ...(dto.accountHolderName ? { accountHolder: dto.accountHolderName } : {})
    });
    let identityProfile: { idNumber?: string | null; frontIdUrl?: string | null; backIdUrl?: string | null } | null = null;
    const result = await prisma.$transaction(async (tx) => {

      // ==========================================
      // STEP 1: Update Basic User Table & Profiles
      // ==========================================
      const userUpdates: any = {};
      if (dto.avatarUrl !== undefined) userUpdates.avatarUrl = avatarUrl;
      if (dto.phoneNumber !== undefined) userUpdates.phoneNumber = dto.phoneNumber;

      const updatedUser = Object.keys(userUpdates).length > 0
        ? await tx.user.update({ where: { id: userId }, data: userUpdates })
        : await tx.user.findUnique({ where: { id: userId } });

      // Upsert the active role's profile details, then recalculate that
      // role's REAL completion score from the final state (Phase 3D.2A) —
      // replacing the old unconditional User=100 hardcode. The upsert always
      // runs (even with an empty update payload, a safe no-op) so there is a
      // full row to read back, since User-level factors written above
      // (avatarUrl/phoneNumber for CLIENT) can move the score even when this
      // request carried no role-profile fields at all.
      if (activeRole === UserRole.CLIENT) {
        const clientData: any = {};
        if (dto.bio !== undefined) clientData.bio = dto.bio;
        if (dto.companyName !== undefined) clientData.companyName = dto.companyName;
        if (dto.industry !== undefined) clientData.industry = dto.industry;
        Object.assign(clientData, identityAndBankData());

        const clientProfile = await tx.clientProfile.upsert({
          where: { userId },
          create: { userId, ...clientData },
          update: clientData
        });
        identityProfile = clientProfile as any;

        const completion = computeClientCompletion({ user: updatedUser || {}, clientProfile });
        await tx.clientProfile.update({ where: { userId }, data: { completionPercentage: completion } });
      } else {
        // PROVIDER — the only other branch reachable, per the guard above.
        const providerData: any = {};
        if (dto.bio !== undefined) providerData.bio = dto.bio;
        if (dto.hourlyRate !== undefined) providerData.hourlyRate = dto.hourlyRate;
        Object.assign(providerData, identityAndBankData());
        if (skillConnections) providerData.skills = { connect: skillConnections };

        const providerProfile = await tx.providerProfile.upsert({
          where: { userId },
          create: { userId, ...providerData },
          update: providerData
        });
        identityProfile = providerProfile as any;

        const completion = computeProviderCompletion({ providerProfile, user: updatedUser || {} });
        await tx.providerProfile.update({ where: { userId }, data: { completionPercentage: completion } });
      }

      // The identity / bank fields above were written to the role profile like the main wizards do. Nothing is queued anywhere: the response
      // says only what really happened.
      return { setupCompleted: true };
    });

    // Submitting a changed, complete identity opens (or refreshes) the same review the main wizards open; an unchanged re-save does not.
    const changed = identitySubmissionChanged(storedIdentity, { idNumber: dto.idNumber }, { front: frontIdUrl, back: backIdUrl });
    let identitySubmitted = false;
    if (changed && identityProfile) {
      const p = identityProfile as { idNumber?: string | null; frontIdUrl?: string | null; backIdUrl?: string | null };
      if (activeRole === UserRole.CLIENT) {
        identitySubmitted = Boolean(await onboardingService.submitSetupDocuments(userId, { idNumber: p.idNumber, frontIdUrl: p.frontIdUrl, backIdUrl: p.backIdUrl }, { identityChanged: true }));
      } else if (p.idNumber && p.frontIdUrl && p.backIdUrl) {
        await prisma.providerProfile.updateMany({ where: { userId, kycStatus: { in: ['UNVERIFIED', 'REJECTED'] } }, data: { kycStatus: 'PENDING' } });
        identitySubmitted = true;
      }
    }
    return { ...result, identitySubmitted };
  }
}

export const profileSetupService = new ProfileSetupService();
