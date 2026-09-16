import { AIAuditResult } from '@prisma/client';
import { prisma } from '../config/db';
import {
  profileIntelligenceContextService,
} from './profile-intelligence-context.service';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  ProfileSensitiveChangeContext,
  ProfileSensitiveChangeReviewOutput,
} from '../modules/ai-engine';

const AI_RECOMMENDATION_MAX_LENGTH = 1000;

const boundedRecommendation = (
  analysis: ProfileSensitiveChangeReviewOutput
): string => {
  const parts = [
    analysis.summary,
    analysis.rationale,
    analysis.concerns.length > 0
      ? `Concerns: ${analysis.concerns.join(' | ')}`
      : '',
    analysis.missingVerification.length > 0
      ? `Missing verification: ${analysis.missingVerification.join(' | ')}`
      : '',
  ].filter(Boolean);

  return parts.join('\n').slice(0, AI_RECOMMENDATION_MAX_LENGTH);
};

const providerAuditStatus = (
  analysis: ProfileSensitiveChangeReviewOutput
): AIAuditResult => {
  return analysis.reviewLevel === 'normal'
    ? AIAuditResult.NEEDS_HUMAN_REVIEW
    : AIAuditResult.FLAGGED;
};

export class ProfileIntelligenceAiService {
  async enrichProviderModificationRequest(
    requestId: string,
    actorUserId: string
  ) {
    const { context, auditRefs } =
      await profileIntelligenceContextService
        .buildProviderModificationRequestContext(requestId);

    const result = await structuredAiExecutionService.execute<
      ProfileSensitiveChangeContext,
      ProfileSensitiveChangeReviewOutput
    >({
      capability: 'profile_intelligence',
      operation: 'sensitive_change_review',
      input: context,
      locale: 'ar',
      auditContext: {
        actorUserId,
        primaryEntity: {
          type: auditRefs.entityType,
          id: auditRefs.requestId,
        },
        relatedEntities: [{ type: 'USER', id: auditRefs.userId }],
      },
    });

    if (!result.success) return null;

    return prisma.profileModificationRequest.update({
      where: { id: requestId },
      data: {
        aiRecommendation: boundedRecommendation(result.data),
        aiAuditStatus: providerAuditStatus(result.data),
        aiConfidence: null,
      },
    });
  }

  async enrichAffiliateProfileChangeRequest(
    requestId: string,
    actorUserId: string
  ) {
    const { context, auditRefs } =
      await profileIntelligenceContextService
        .buildAffiliateProfileChangeRequestContext(requestId);

    const result = await structuredAiExecutionService.execute<
      ProfileSensitiveChangeContext,
      ProfileSensitiveChangeReviewOutput
    >({
      capability: 'profile_intelligence',
      operation: 'sensitive_change_review',
      input: context,
      locale: 'ar',
      auditContext: {
        actorUserId,
        primaryEntity: {
          type: auditRefs.entityType,
          id: auditRefs.requestId,
        },
        relatedEntities: [{ type: 'USER', id: auditRefs.userId }],
      },
    });

    if (!result.success) return null;

    return prisma.profileChangeRequest.update({
      where: { id: requestId },
      data: {
        aiRecommendation: boundedRecommendation(result.data),
        aiConfidenceScore: null,
      },
    });
  }
}

export const profileIntelligenceAiService =
  new ProfileIntelligenceAiService();
