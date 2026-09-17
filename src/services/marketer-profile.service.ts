import { prisma } from '../config/db';
import { SensitiveFieldType, ChangeRequestStatus } from '@prisma/client';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { computeAffiliateCompletion } from '../utils/completion-calculators';

export class MarketerProfileService {
  
  public async getProfile(userId: string) {
    const profile = await prisma.affiliateProfile.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            phoneCountryCode: true,
            idNumber: true,
            avatarUrl: true
          }
        },
        marketingChannels: true
      }
    });

    if (!profile) {
      throw new Error('Affiliate profile not found');
    }

    return profile;
  }

  public async updateMarketingInfo(userId: string, data: { avatarUrl?: string; bio?: string }) {
	const avatarUrl = data.avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(data.avatarUrl, `waseetai/marketers/${userId}/avatar`, 'avatar');
    const profile = await prisma.affiliateProfile.update({
      where: { userId },
      data: {
        avatarUrl,
        bio: data.bio
      }
    });
    
    await this.recalculateCompletion(userId);
    return profile;
  }

  public async addChannel(userId: string, data: { platform: string; handle: string; url?: string }) {
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('Affiliate profile not found');

    const channel = await prisma.affiliateChannelHandle.create({
      data: {
        affiliateProfileId: profile.id,
        platform: data.platform,
        handle: data.handle,
        url: data.url
      }
    });

    await this.recalculateCompletion(userId);
    return channel;
  }

  public async removeChannel(userId: string, channelId: string) {
    const channel = await prisma.affiliateChannelHandle.findUnique({ where: { id: channelId } });
    if (!channel) throw new Error('Channel not found');

    const profile = await prisma.affiliateProfile.findUnique({ where: { id: channel.affiliateProfileId } });
    if (profile?.userId !== userId) throw new Error('Unauthorized');

    await prisma.affiliateChannelHandle.delete({ where: { id: channelId } });
    await this.recalculateCompletion(userId);
    return { success: true };
  }

  public async updateBankInfo(userId: string, data: { bankName?: string; accountHolderName?: string; iban?: string; swiftCode?: string }) {
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('Affiliate profile not found');

    let isPendingRequest = false;
    let requestId = undefined;

    // Check if IBAN is being updated and is different from current
    if (data.iban && data.iban !== profile.iban) {
      isPendingRequest = true;
      requestId = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;

      await prisma.profileChangeRequest.create({
        data: {
          requestNumber: requestId,
          affiliateProfileId: profile.id,
          fieldType: SensitiveFieldType.IBAN,
          fieldLabel: 'رقم الحساب البنكي IBAN',
          currentValue: profile.iban || '',
          requestedValue: data.iban,
          status: ChangeRequestStatus.PENDING_AI_REVIEW,
          aiRecommendation: 'يتحقق الذكاء من تطابق اسم صاحب الحساب الجديد مع الهوية ومن سلامة صيغة IBAN قبل رفعه للمراجع البشري',
          aiConfidenceScore: 95
        }
      });
      
      // Remove sensitive fields from direct update
      delete data.iban;
    }

    // Direct update for non-sensitive or unchanged fields
    const updated = await prisma.affiliateProfile.update({
      where: { userId },
      data: {
        bankName: data.bankName,
        accountHolderName: data.accountHolderName,
        swiftCode: data.swiftCode
      }
    });

    await this.recalculateCompletion(userId);

    return {
      success: true,
      isPendingRequest,
      requestId,
      data: updated
    };
  }

  private async recalculateCompletion(userId: string) {
    const profile = await prisma.affiliateProfile.findUnique({
      where: { userId },
      include: {
        user: true,
        marketingChannels: true
      }
    });

    if (!profile) return;

    // Phase 3D.4: delegates to the shared pure calculator (src/utils/
    // completion-calculators.ts) so role-creation initialization
    // (account-management.service.ts) can compute the exact same score
    // without depending on this DB-querying service. Behavior-preserving
    // extraction only — same fields, same weights, same null/empty semantics.
    const percentage = computeAffiliateCompletion({
      user: profile.user,
      affiliateProfile: profile,
      marketingChannelsCount: profile.marketingChannels?.length || 0
    });

    await prisma.affiliateProfile.update({
      where: { userId },
      data: { completionPercentage: percentage }
    });
  }
}

export const marketerProfileService = new MarketerProfileService();
