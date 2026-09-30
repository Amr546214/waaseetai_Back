import { prisma } from '../config/db';
import { SensitiveFieldType } from '@prisma/client';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { computeAffiliateCompletion } from '../utils/completion-calculators';
import { createGovernedFieldRequests, FieldChangeCandidate } from './profile-requests.service';
import { AppError } from '../utils/app-error';
import { AFFILIATE_PROFILE_SAFE_SCALAR_SELECT } from '../utils/affiliate-profile-safe-select.util';

// Explicit public-safe shape (Implementation Batch 3, Part A). Never the
// full AffiliateProfile row — bank/IBAN/KYC/email/phone/commission-rate
// fields must never reach this response. Built from a `select`, not
// `include`, so a future schema field is never accidentally exposed by
// default.
export interface MarketerPublicProfile {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  level: string;
  identityVerified: boolean;
  channels: { platform: string; handle: string; url: string | null }[];
  channelMetrics: { channel: string; visitors: number; clients: number; conversionPercentage: number }[] | null;
}

export class MarketerProfileService {

  public async getProfile(userId: string) {
    // Explicit select — deployment-safety fix. This result is forwarded
    // as-is (`data: profile`) to the marketer's own profile page, so the
    // full pre-existing AffiliateProfile scalar shape is preserved via
    // AFFILIATE_PROFILE_SAFE_SCALAR_SELECT (everything except the new,
    // not-yet-migrated `level` column — see
    // src/utils/affiliate-profile-safe-select.util.ts). The previous bare
    // `include` did not restrict AffiliateProfile's own scalars and would
    // have requested `level`, 500ing this endpoint.
    const profile = await prisma.affiliateProfile.findUnique({
      where: { userId },
      select: {
        ...AFFILIATE_PROFILE_SAFE_SCALAR_SELECT,
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

  /**
   * Public read — no auth. Never reuse getProfile's `include` here: this
   * must stay an explicit `select` allowlist so bank/IBAN document/email/
   * phone/commissionRatePercentage/payoutMethod fields can never leak, even
   * if new columns are added to AffiliateProfile later. `identityVerified`
   * is a plain boolean status flag (not the KYC document itself), so it is
   * safe to expose — the real, honest replacement for the old fake
   * `isVerified: true` badge the frontend used to hardcode. `id` is the marketer's
   * User id (same convention as the provider public-profile precedent,
   * provider-profile.service.ts:getPublicProfile, which looks up by
   * `userId`, not the profile's own internal id).
   * Channel performance numbers (visitors/clients/conversionPercentage) are
   * only returned when the marketer has opted in via the existing
   * `sharePerformanceStats` flag — otherwise `channelMetrics` is `null`
   * (opted-out), never a fabricated `[]` implying "zero traffic".
   */
  public async getPublicProfile(userId: string): Promise<MarketerPublicProfile> {
    const profile = await prisma.affiliateProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        bio: true,
        currentLevel: true,
        identityVerified: true,
        sharePerformanceStats: true,
        user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        marketingChannels: { select: { platform: true, handle: true, url: true } },
      },
    });

    if (!profile) {
      throw new AppError('الملف الشخصي غير موجود', 404);
    }

    const firstName = profile.firstName || profile.user.firstName || '';
    const lastName = profile.lastName || profile.user.lastName || '';
    const name = `${firstName} ${lastName}`.trim();

    let channelMetrics: MarketerPublicProfile['channelMetrics'] = null;
    if (profile.sharePerformanceStats) {
      const metrics = await prisma.affiliateChannelMetric.findMany({
        where: { affiliateId: profile.id },
        select: { channel: true, visitors: true, clients: true, conversionPercentage: true },
      });
      channelMetrics = metrics;
    }

    return {
      id: userId,
      name: name || null,
      avatarUrl: profile.avatarUrl || profile.user.avatarUrl || null,
      bio: profile.bio || null,
      identityVerified: profile.identityVerified,
      level: profile.currentLevel,
      channels: profile.marketingChannels,
      channelMetrics,
    };
  }

  public async updateMarketingInfo(userId: string, data: { avatarUrl?: string; bio?: string }) {
	const avatarUrl = data.avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(data.avatarUrl, `waseetai/marketers/${userId}/avatar`, 'avatar');
    // Explicit select — deployment-safety fix; return value is forwarded
    // as-is to the API response, so the full pre-existing scalar shape is
    // preserved (see AFFILIATE_PROFILE_SAFE_SCALAR_SELECT).
    const profile = await prisma.affiliateProfile.update({
      where: { userId },
      data: {
        avatarUrl,
        bio: data.bio
      },
      select: AFFILIATE_PROFILE_SAFE_SCALAR_SELECT
    });

    await this.recalculateCompletion(userId);
    return profile;
  }

  public async addChannel(userId: string, data: { platform: string; handle: string; url?: string }) {
    // Explicit select — deployment-safety fix; only `id` is used below.
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId }, select: { id: true } });
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

    // Explicit select — deployment-safety fix; only `userId` is used below.
    const profile = await prisma.affiliateProfile.findUnique({ where: { id: channel.affiliateProfileId }, select: { userId: true } });
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
      // Explicit select — deployment-safety fix; only these fields are read
      // below (id + the 4 bank fields being compared/governed).
      const profile = await tx.affiliateProfile.findUnique({
        where: { userId },
        select: { id: true, iban: true, bankName: true, accountHolderName: true, swiftCode: true }
      });
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
    // Explicit select — deployment-safety fix; this is a private helper
    // whose return value is never forwarded to a caller (only used to
    // compute `percentage` below), so only the exact fields
    // computeAffiliateCompletion() reads are selected: avatarUrl/bio/iban
    // from AffiliateProfile itself, the marketing-channels COUNT (not the
    // rows), and firstName/lastName/email/avatarUrl from the related User.
    const profile = await prisma.affiliateProfile.findUnique({
      where: { userId },
      select: {
        avatarUrl: true,
        bio: true,
        iban: true,
        marketingChannels: { select: { id: true } },
        user: { select: { firstName: true, lastName: true, email: true, avatarUrl: true } }
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

    // Explicit select — deployment-safety fix; return value unused.
    await prisma.affiliateProfile.update({
      where: { userId },
      data: { completionPercentage: percentage },
      select: { id: true }
    });
  }
}

export const marketerProfileService = new MarketerProfileService();
