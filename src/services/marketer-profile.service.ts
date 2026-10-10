import { prisma } from '../config/db';
import { Prisma } from '@prisma/client';
import { logger } from '../config/logger';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { computeAffiliateCompletion, computeAffiliateMissingItems } from '../utils/completion-calculators';
import { AppError } from '../utils/app-error';
import { deriveReviewEntry, NOT_SUBMITTED, type ReviewEntry } from '../utils/review-status';
import { AFFILIATE_PROFILE_SAFE_SCALAR_SELECT } from '../utils/affiliate-profile-safe-select.util';
import { readAffiliatePaypalEmail, readAffiliateKycReview, withoutLegacyAffiliateBankFields } from '../utils/affiliate-payout';

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

    // Completion is recomputed from the rows just read (a stored value that predates the current formula is healed on read) and returned
    // with what is still missing. The stored column is synced when it differs (best effort, never fails the read).
    const paypalPayoutEmail = await readAffiliatePaypalEmail(userId, prisma);
    const completionInput = {
      user: profile.user,
      affiliateProfile: { ...profile, paypalPayoutEmail },
      marketingChannelsCount: profile.marketingChannels?.length || 0
    };
    const completionPercentage = computeAffiliateCompletion(completionInput);
    const missingItems = computeAffiliateMissingItems(completionInput);
    if (profile.completionPercentage !== completionPercentage) {
      try {
        await prisma.affiliateProfile.update({ where: { userId }, data: { completionPercentage }, select: { id: true } });
      } catch (error) {
        logger.error(`[MarketerProfileService] Failed to sync stored completion (userId=${userId})`, error);
      }
    }

    // PayPal is the only payout destination: the legacy bank columns are never returned.
    // One review lifecycle: the name / national id / phone requests (admin-decided) and the identity document. PayPal and the marketing profile save at once.
    let basicInfo: ReviewEntry = { ...NOT_SUBMITTED };
    try {
      const rows = await prisma.profileChangeRequest.findMany({
        where: { affiliateProfileId: profile.id, fieldType: { in: ['FIRST_NAME', 'LAST_NAME', 'NATIONAL_ID', 'PHONE_NUMBER'] as any } },
        orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, fieldType: true, status: true, createdAt: true, updatedAt: true, rejectionReason: true }
      });
      basicInfo = deriveReviewEntry(rows.map(r => ({ ...r, category: 'MARKETER_BASIC_INFO' })) as any);
    } catch (error) {
      logger.error(`[MarketerProfileService] Could not read review status (userId=${userId})`, error);
    }
    // The KYC document keeps no request row: the state is on the profile. A stored document with no approval is waiting; a rejected one
    // is cleared but its reason and time are kept (kycRejectionReason / kycReviewedAt).
    const kycReview = (profile as any).identityVerified || (profile as any).kycDocumentUrl ? { rejectionReason: null, reviewedAt: null } : await readAffiliateKycReview(userId, prisma);
    const documents: ReviewEntry = (profile as any).identityVerified ? { ...NOT_SUBMITTED, status: 'APPROVED' }
      : (profile as any).kycDocumentUrl ? { ...NOT_SUBMITTED, status: 'PENDING_REVIEW' }
      : kycReview.rejectionReason ? { ...NOT_SUBMITTED, status: 'REJECTED', rejectionReason: kycReview.rejectionReason, reviewedAt: kycReview.reviewedAt ? new Date(kycReview.reviewedAt).toISOString() : null }
      : { ...NOT_SUBMITTED };
    return Object.assign(withoutLegacyAffiliateBankFields(profile), { paypalPayoutEmail, completionPercentage, missingItems, reviewStatus: { basicInfo, documents } });
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
    return withoutLegacyAffiliateBankFields(profile);
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
   * Saves (or, with an empty value, removes) the marketer's PayPal payout email: the only payout destination. Applied at once (an email is
   * not a governed identity field). A database without the column yet answers a clear 503 instead of a raw error.
   */
  public async updatePaypalPayout(userId: string, email: string | null | undefined) {
    const value = email ? String(email).trim().toLowerCase() : null;
    try {
      const updated = await prisma.affiliateProfile.update({ where: { userId }, data: { paypalPayoutEmail: value }, select: { id: true } });
      if (!updated) throw new AppError('ملف الوسيط التسويقي غير موجود', 404);
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      if (error?.code === 'P2025') throw new AppError('ملف الوسيط التسويقي غير موجود', 404);
      if (error?.code === 'P2022') throw new AppError('حفظ بريد PayPal غير متاح مؤقتًا، حاول لاحقًا', 503);
      throw error;
    }
    await this.recalculateCompletion(userId);
    return { success: true, paypalPayoutEmail: value };
  }

  /**
   * Recomputes and stores AffiliateProfile.completionPercentage. Called after every write that changes a scored input
   * (avatar, bio, channel add/remove, an admin approving the IBAN or a name) and by the legacy AFFILIATE profile paths.
   * Accepts a transaction client so a caller inside a $transaction recomputes from its own uncommitted writes.
   */
  public async recalculateCompletion(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    // Explicit select — deployment-safety fix; only the exact fields computeAffiliateCompletion() reads.
    const profile = await client.affiliateProfile.findUnique({
      where: { userId },
      select: {
        avatarUrl: true,
        bio: true,
        marketingChannels: { select: { id: true } },
        user: { select: { avatarUrl: true } }
      }
    });

    if (!profile) return;

    const paypalPayoutEmail = await readAffiliatePaypalEmail(userId, prisma) // outside the transaction: a missing column must not abort it;
    const percentage = computeAffiliateCompletion({
      user: profile.user,
      affiliateProfile: { ...profile, paypalPayoutEmail },
      marketingChannelsCount: profile.marketingChannels?.length || 0
    });

    // Explicit select — deployment-safety fix; return value unused.
    await client.affiliateProfile.update({
      where: { userId },
      data: { completionPercentage: percentage },
      select: { id: true }
    });
  }
}

export const marketerProfileService = new MarketerProfileService();
