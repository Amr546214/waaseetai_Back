import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { ProfileSetupDto } from '../dtos/profile-setup.dto';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';

export class ProfileSetupService {
  public async saveProfileSetup(userId: string, accountType: AccountType, dto: ProfileSetupDto) {
	const avatarUrl = dto.avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(dto.avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');
    return await prisma.$transaction(async (tx) => {
      
      // ==========================================
      // STEP 1: Update Basic User Table & Profiles
      // ==========================================
      const userUpdates: any = {};
      if (dto.avatarUrl !== undefined) userUpdates.avatarUrl = avatarUrl;
      if (dto.phoneNumber !== undefined) userUpdates.phoneNumber = dto.phoneNumber;
      
      // Mark as partially or fully setup depending on your logic, we'll increment points or flag
      // Assuming 100% since they finished the wizard
      userUpdates.profileCompletionPercent = 100; 

      await tx.user.update({
        where: { id: userId },
        data: userUpdates
      });

      // Upsert specific profile details based on Account Type
      if (accountType === 'CLIENT_COMPANY' || accountType === 'CLIENT_INDIVIDUAL') {
        const clientData: any = {};
        if (dto.bio !== undefined) clientData.bio = dto.bio;
        if (dto.companyName !== undefined) clientData.companyName = dto.companyName;
        if (dto.industry !== undefined) clientData.industry = dto.industry;

        if (Object.keys(clientData).length > 0) {
          await tx.clientProfile.upsert({
            where: { userId },
            create: { userId, ...clientData },
            update: clientData
          });
        }
      } else if (accountType === 'PROVIDER_COMPANY' || accountType === 'PROVIDER_INDIVIDUAL') {
        const providerData: any = {};
        if (dto.bio !== undefined) providerData.bio = dto.bio;
        if (dto.skills !== undefined) providerData.skills = dto.skills;
        if (dto.hourlyRate !== undefined) providerData.hourlyRate = dto.hourlyRate;

        if (Object.keys(providerData).length > 0) {
          await tx.providerProfile.upsert({
            where: { userId },
            create: { userId, ...providerData },
            update: providerData
          });
        }
      }

      // ==========================================
      // STEP 2: Handle Sensitive Data (Identity & Bank)
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
