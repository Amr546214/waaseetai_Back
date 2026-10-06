import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { ProjectStatus } from '@prisma/client';

// Batch 6 — real public client profile. Replaces the frontend's previous
// buildMockClientProfile() (hardcoded aiTrust 94/97/89 + a fabricated "97%
// payment rate" recommendation string). Every field here is a genuine
// deterministic aggregate of real rows — no Gemini call, no invented
// "trust score"/"payment rate"/"commitment percentage". An honest,
// facts-only profile is preferable to a fabricated score (see the Batch 6
// audit). No sensitive fields (national ID, DOB, address, bank/IBAN, KYC
// documents, email, phone) are ever selected here.

export interface ClientPublicProfileStats {
  completedProjects: number;
  activeProjects: number;
  totalContracts: number;
  providerReviewsCount: number;
  providerRatingAverage: number | null;
}

export interface ClientPublicProfileReview {
  rating: number;
  comment: string | null;
  createdAt: string;
  providerName: string | null;
}

export interface ClientPublicProfile {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  city: string | null;
  country: string | null;
  memberSince: string;
  isVerified: boolean;
  stats: ClientPublicProfileStats;
  reviewsFromProviders: ClientPublicProfileReview[];
}

const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = [
  ProjectStatus.IN_PROGRESS,
  ProjectStatus.AWAITING_DELIVERY,
  ProjectStatus.PENDING_APPROVAL
];

export class ClientProfileService {
  /**
   * Public, unauthenticated read of a real client's profile by their User
   * id. Existence of a ClientProfile row is the same access gate the
   * provider/marketer public-profile endpoints use for their own role
   * profiles — a non-client id simply 404s, since it has no ClientProfile row.
   *
   * Deliberately does NOT expose: individual project titles/prices (a
   * client's specific project needs/spend), dispute history, or revision
   * counts — those either carry financial detail or don't meaningfully
   * describe client trustworthiness. The one genuinely relevant, real
   * "trust" signal is the average of reviews providers left about this
   * client after working with them (Review.reviewerRole === 'PROVIDER'),
   * shown as-is with its real count — never defaulted to a positive number
   * when there is no history.
   */
  async getPublicProfile(userId: string): Promise<ClientPublicProfile> {
    const [user, clientProfile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, avatarUrl: true, createdAt: true }
      }),
      prisma.clientProfile.findUnique({
        where: { userId },
        select: { firstName: true, lastName: true, avatarUrl: true, bio: true, city: true, country: true, kycStatus: true }
      })
    ]);
    if (!user || !clientProfile) throw new AppError('الملف الشخصي غير موجود', 404);

    const [completedProjects, activeProjects, totalContracts, providerReviewsCount, ratingAggregate, recentReviews] = await Promise.all([
      prisma.project.count({ where: { clientId: userId, status: ProjectStatus.COMPLETED } }),
      prisma.project.count({ where: { clientId: userId, status: { in: ACTIVE_PROJECT_STATUSES } } }),
      prisma.contract.count({ where: { clientId: userId } }),
      prisma.review.count({ where: { clientId: userId, reviewerRole: 'PROVIDER' } }),
      prisma.review.aggregate({ where: { clientId: userId, reviewerRole: 'PROVIDER' }, _avg: { rating: true } }),
      prisma.review.findMany({
        where: { clientId: userId, reviewerRole: 'PROVIDER' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { rating: true, comment: true, createdAt: true, provider: { select: { firstName: true, lastName: true } } }
      })
    ]);

    const firstName = clientProfile.firstName || user.firstName || '';
    const lastName = clientProfile.lastName || user.lastName || '';
    const name = `${firstName} ${lastName}`.trim();

    return {
      id: userId,
      name: name || null,
      avatarUrl: clientProfile.avatarUrl || user.avatarUrl || null,
      bio: clientProfile.bio || null,
      city: clientProfile.city || null,
      country: clientProfile.country || null,
      memberSince: user.createdAt.toISOString(),
      // verified only by an approved KYC review (the old source, isNafathVerified, had no real verification behind it)
      isVerified: clientProfile.kycStatus === 'VERIFIED',
      stats: {
        completedProjects,
        activeProjects,
        totalContracts,
        providerReviewsCount,
        // Honest null (not 0) when there is genuinely no review history yet —
        // 0 would misleadingly read as "rated zero" rather than "unrated".
        providerRatingAverage: providerReviewsCount > 0 ? Number(ratingAggregate._avg.rating) : null
      },
      reviewsFromProviders: recentReviews.map(r => ({
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        providerName: `${r.provider.firstName || ''} ${r.provider.lastName || ''}`.trim() || null
      }))
    };
  }
}

export const clientProfileService = new ClientProfileService();
