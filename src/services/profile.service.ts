import { AccountType, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { UpdateProfileDto } from '../dtos/profile.dto';
import { AppError } from '../utils/app-error';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';

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
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        clientProfile: true,
        providerProfile: true,
        affiliateProfile: true,
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

    return {
      currentProfileData: {
        ...safeUser,
        ...roleProfile,
        ...resolvedDisplayFields
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
