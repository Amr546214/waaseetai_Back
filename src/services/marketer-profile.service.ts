import { prisma } from '../config/db';
import { SensitiveFieldType } from '@prisma/client';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { computeAffiliateCompletion } from '../utils/completion-calculators';
import { createGovernedFieldRequests, FieldChangeCandidate } from './profile-requests.service';

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

  /**
   * ALL banking fields are governed — this page's own "gov-bar" copy says
   * editing "الحساب البنكي والمستندات" creates a request an AI checks and a
   * human approves, but previously only IBAN actually went through
   * ProfileChangeRequest while bankName/accountHolderName/swiftCode were
   * applied immediately (a real gap between the UI's promise and the code).
   * None of the four fields are written directly anymore — every changed
   * field becomes its own governed ProfileChangeRequest via the shared
   * createGovernedFieldRequests helper (same duplicate-pending and
   * unchanged-value rules as the identity-fields flow), and the real
   * AffiliateProfile row is only ever touched later, by an admin approval.
   */
  public async updateBankInfo(userId: string, data: { bankName?: string; accountHolderName?: string; iban?: string; swiftCode?: string }) {
    return prisma.$transaction(async (tx) => {
      const profile = await tx.affiliateProfile.findUnique({ where: { userId } });
      if (!profile) throw new Error('Affiliate profile not found');

      const candidates: FieldChangeCandidate[] = [
        { fieldType: SensitiveFieldType.IBAN, fieldLabel: 'رقم الحساب البنكي IBAN', currentValue: profile.iban, requestedValue: data.iban },
        { fieldType: SensitiveFieldType.BANK_NAME, fieldLabel: 'اسم البنك', currentValue: profile.bankName, requestedValue: data.bankName },
        { fieldType: SensitiveFieldType.ACCOUNT_HOLDER_NAME, fieldLabel: 'اسم صاحب الحساب', currentValue: profile.accountHolderName, requestedValue: data.accountHolderName },
        { fieldType: SensitiveFieldType.SWIFT_CODE, fieldLabel: 'رمز السويفت', currentValue: profile.swiftCode, requestedValue: data.swiftCode }
      ];

      const created = await createGovernedFieldRequests(tx, profile.id, candidates);

      return {
        success: true,
        isPendingRequest: true,
        requests: created
      };
    });
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
