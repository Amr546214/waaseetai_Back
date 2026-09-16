import { prisma } from '../config/db';
import { SensitiveFieldType, ChangeRequestStatus } from '@prisma/client';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import crypto from 'crypto';
import { profileIntelligenceAiService } from './profile-intelligence-ai.service';

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
      requestId = `REQ-${crypto.randomInt(1000, 10000)}`;

      const request = await prisma.profileChangeRequest.create({
        data: {
          requestNumber: requestId,
          affiliateProfileId: profile.id,
          fieldType: SensitiveFieldType.IBAN,
          fieldLabel: 'رقم الحساب البنكي IBAN',
          currentValue: profile.iban || '',
          requestedValue: data.iban,
          status: ChangeRequestStatus.PENDING_HUMAN_APPROVAL,
          aiRecommendation: null,
          aiConfidenceScore: null
        }
      });
      await profileIntelligenceAiService.enrichAffiliateProfileChangeRequest(
        request.id,
        userId
      );
      
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

    let percentage = 0;

    // Avatar (+15%)
    if (profile.avatarUrl || profile.user.avatarUrl) percentage += 15;
    
    // Bio (+15%)
    if (profile.bio && profile.bio.trim().length > 0) percentage += 15;
    
    // At least 1 Channel (+20%)
    if (profile.marketingChannels && profile.marketingChannels.length > 0) percentage += 20;
    
    // IBAN (+20%)
    if (profile.iban && profile.iban.trim().length > 0) percentage += 20;
    
    // User basic info (+30%)
    if (profile.user.firstName && profile.user.lastName && profile.user.email) percentage += 30;

    if (percentage > 100) percentage = 100;

    await prisma.affiliateProfile.update({
      where: { userId },
      data: { completionPercentage: percentage }
    });
  }
}

export const marketerProfileService = new MarketerProfileService();
