import { AccountType, UserStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { UpdateProfileDto } from '../dtos/profile.dto';
import { AppError } from '../utils/app-error';

export class ProfileService {
  /**
   * Fetch a user's full integrated profile
   */
  public async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        clientProfile: true,
        providerProfile: true
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
    const profile = user.accountType.includes('CLIENT') ? user.clientProfile : user.providerProfile;
    
    // Dynamic Score Calculation
    const mergedData = { ...safeUser, ...profile } as any;
    // for (const req of latestHistory) {
    //   if (req.status === 'PENDING') {
    //     Object.assign(mergedData, req.requestedChanges);
    //   }
    // }

    let score = 0;
    const baseFields = ['firstName', 'lastName', 'phoneNumber', 'avatarUrl'];
    baseFields.forEach(f => { if (mergedData[f]) score += 7.5; });

    const metaFields = ['bio', 'companyName', 'companySize', 'industry', 'website'];
    metaFields.forEach(f => { if (mergedData[f]) score += 6.0; });

    const kycFields = ['idNumber', 'idExpiryDate'];
    kycFields.forEach(f => { if (mergedData[f]) score += 10.0; });

    const bankingFields = ['ibanNumber', 'bankName', 'accountHolderName'];
    bankingFields.forEach(f => { if (mergedData[f]) score += (20 / 3); });

    const finalScore = Math.min(100, Math.round(score));

    if (safeUser.profileCompletionPercent !== finalScore) {
      await prisma.user.update({
        where: { id: userId },
        data: { profileCompletionPercent: finalScore }
      });
      safeUser.profileCompletionPercent = finalScore;
    }

    return {
      currentProfileData: {
        ...safeUser,
        ...profile
      },
      latestHistory
    };
  }

  /**
   * Update User fields and nested profile metadata using $transaction
   */
  public async updateProfile(userId: string, accountType: AccountType, dto: UpdateProfileDto) {
    const {
      firstName,
      lastName,
      phoneNumber,
      avatarUrl,
      ...profileData
    } = dto;
	const storedAvatarUrl = avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');

    return await prisma.$transaction(async (tx) => {
      // 1. Update Core User fields if provided
      const userUpdateData: any = {};
      if (firstName !== undefined) userUpdateData.firstName = firstName;
      if (lastName !== undefined) userUpdateData.lastName = lastName;
      if (phoneNumber !== undefined) userUpdateData.phoneNumber = phoneNumber;
      if (avatarUrl !== undefined) userUpdateData.avatarUrl = storedAvatarUrl;
      
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

      // 2. Update Profile data
      let profileResult = null;
      if (Object.keys(profileData).length > 0) {
        if (accountType === AccountType.CLIENT_COMPANY || accountType === AccountType.CLIENT_INDIVIDUAL) {
          profileResult = await tx.clientProfile.upsert({
            where: { userId },
            create: { userId, ...(profileData as any) },
            update: profileData as any
          });
        } else {
          // Clean undefined/incompatible properties for Provider
          const providerData: any = { ...profileData };
          delete providerData.companySize;
          delete providerData.industry;
          delete providerData.website;

          profileResult = await tx.providerProfile.upsert({
            where: { userId },
            create: { userId, ...(providerData as any) },
            update: providerData as any
          });
        }
      }

      return {
        user: updatedUser,
        profile: profileResult
      };
    });
  }

  /**
   * Update Profile by Tab Name with moderation flow
   */
  public async updateTab(userId: string, tabName: string, data: any) {
    if (tabName === 'basics' || tabName === 'contact') {
      const { email, phoneNumber, ...safeData } = data;
      
      // Update safe data immediately
      await prisma.user.update({
        where: { id: userId },
        data: safeData
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
