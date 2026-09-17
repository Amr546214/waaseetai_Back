import { UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { ProfileSetupDto } from '../dtos/profile-setup.dto';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { AppError } from '../utils/app-error';
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

    const avatarUrl = dto.avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(dto.avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');
    return await prisma.$transaction(async (tx) => {

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

        const clientProfile = await tx.clientProfile.upsert({
          where: { userId },
          create: { userId, ...clientData },
          update: clientData
        });

        const completion = computeClientCompletion({ user: updatedUser || {}, clientProfile });
        await tx.clientProfile.update({ where: { userId }, data: { completionPercentage: completion } });
      } else {
        // PROVIDER — the only other branch reachable, per the guard above.
        const providerData: any = {};
        if (dto.bio !== undefined) providerData.bio = dto.bio;
        if (dto.skills !== undefined) providerData.skills = dto.skills;
        if (dto.hourlyRate !== undefined) providerData.hourlyRate = dto.hourlyRate;

        const providerProfile = await tx.providerProfile.upsert({
          where: { userId },
          create: { userId, ...providerData },
          update: providerData
        });

        const completion = computeProviderCompletion({ providerProfile, user: updatedUser || {} });
        await tx.providerProfile.update({ where: { userId }, data: { completionPercentage: completion } });
      }

      // ==========================================
      // STEP 2: Handle Sensitive Data (Identity & Bank) — UNCHANGED
      // ==========================================
      const sensitiveChanges: any = {};

      // Check for identity fields
      if (dto.idNumber || dto.idExpiryDate || dto.nationality || dto.city || dto.country || dto.frontId || dto.backId || dto.supportingDocs) {
        if (dto.idNumber) sensitiveChanges.idNumber = dto.idNumber;
        if (dto.idExpiryDate) sensitiveChanges.idExpiryDate = dto.idExpiryDate;
        if (dto.nationality) sensitiveChanges.nationality = dto.nationality;
        if (dto.city) sensitiveChanges.city = dto.city;
        if (dto.country) sensitiveChanges.country = dto.country;
        if (dto.frontId) sensitiveChanges.frontId = dto.frontId;
        if (dto.backId) sensitiveChanges.backId = dto.backId;
        if (dto.supportingDocs) sensitiveChanges.supportingDocs = dto.supportingDocs;
      }

      // Check for bank fields
      if (dto.ibanNumber || dto.bankName || dto.accountHolderName) {
        if (dto.ibanNumber) sensitiveChanges.ibanNumber = dto.ibanNumber;
        if (dto.bankName) sensitiveChanges.bankName = dto.bankName;
        if (dto.accountHolderName) sensitiveChanges.accountHolderName = dto.accountHolderName;
      }

      // If sensitive changes exist, route them to the moderation queue
      let changeRequest: any = null;
      if (Object.keys(sensitiveChanges).length > 0) {
        // changeRequest = await tx.profileChangeRequest.create({
        //   data: {
        //     userId,
        //     status: 'PENDING',
        //     tabName: 'ONBOARDING_SETUP',
        //     requestedChanges: sensitiveChanges
        //   }
        // });
      }

      // ==========================================
      // STEP 3: Return success payload
      // ==========================================
      return {
        setupCompleted: true,
        moderationQueued: Object.keys(sensitiveChanges).length > 0,
        changeRequestId: changeRequest?.id || null
      };
    });
  }
}

export const profileSetupService = new ProfileSetupService();
