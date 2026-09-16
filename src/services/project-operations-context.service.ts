import type {
  ProjectHealthAnalysisAiOutput,
  ProjectOperationsContext,
} from '../modules/ai-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DESCRIPTION_EXCERPT_LENGTH = 500;

export interface ProjectOperationsPublicAiInsights {
  confidence: number;
  earlyDays: number;
  matchPercentage: number | null;
  riskLevel: string;
  riskLevelKey: string;
  healthRating: string;
  bullets: string[];
}

interface ProjectOperationsDeliveryLike {
  status: string;
  submittedAt: Date;
}

interface ProjectOperationsStageLike {
  stepOrder: number;
  status: string;
  days: number;
  percentage: number;
  startedAt: Date | null;
  approvedAt: Date | null;
  deliveries: ProjectOperationsDeliveryLike[];
  stageReviews?: Array<{ rating: number }>;
}

interface ProjectOperationsContractLike {
  id: string;
  projectId: string;
  status: string;
  signedAt: Date | null;
  createdAt: Date;
  durationDays: number;
  phasesCount: number;
  project: {
    id: string;
    title: string;
    description: string;
    status: string;
    specialty: string;
    subSpecialties: string[];
    deliveryDays: number;
    createdAt: Date;
    updatedAt: Date;
    escrow?: {
      status: string;
      amount: number;
      releasedAmount: number;
    } | null;
    conversations?: Array<{
      messages?: Array<{ createdAt: Date }>;
    }>;
    disputes?: Array<{ status: string }>;
    reviews?: Array<{
      reviewerRole: string;
      rating: number;
      stageId?: string | null;
    }>;
  };
}

export interface BuildProjectOperationsContextInput {
  actorRole: 'client' | 'provider';
  contract: ProjectOperationsContractLike;
  stages: ProjectOperationsStageLike[];
  progressPercent: number;
  now?: Date;
}

type ProjectRiskLevelKey = ProjectHealthAnalysisAiOutput['riskLevelKey'];

export const PROJECT_OPERATIONS_RISK_LABELS_AR: Record<
  ProjectRiskLevelKey,
  string
> = {
  none: 'لا توجد مخاطر ظاهرة',
  low: 'مخاطر منخفضة',
  medium: 'مخاطر متوسطة',
  high: 'مخاطر مرتفعة',
};

const ACTIVE_CONTRACT_STATUSES = new Set(['ACTIVE']);
const ACTIVE_PROJECT_STATUSES = new Set([
  'IN_PROGRESS',
  'AWAITING_DELIVERY',
  'PENDING_REVIEW',
]);

const toIso = (value: Date | null | undefined): string | null => {
  return value ? value.toISOString() : null;
};

const daysBetween = (from: Date, to: Date): number => {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
};

const countByStatus = <T extends { status: string }>(
  items: T[],
  status: string
): number => {
  return items.filter(item => item.status === status).length;
};

const capDescription = (description: string): string | null => {
  const trimmed = description.trim();
  if (!trimmed) return null;
  if (trimmed.length <= DESCRIPTION_EXCERPT_LENGTH) return trimmed;
  return `${trimmed.slice(0, DESCRIPTION_EXCERPT_LENGTH)}...`;
};

const roundPercent = (value: number): number => {
  return Math.min(100, Math.max(0, Math.round(value)));
};

const average = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
};

export class ProjectOperationsContextService {
  createNeutralAiInsights(): ProjectOperationsPublicAiInsights {
    return {
      confidence: 0,
      earlyDays: 0,
      matchPercentage: null,
      riskLevel: 'غير محسوبة',
      riskLevelKey: 'unknown',
      healthRating: 'بانتظار بيانات كافية',
      bullets: [],
    };
  }

  isEligibleForProjectHealthAnalysis(
    input: BuildProjectOperationsContextInput
  ): boolean {
    const { contract, stages, progressPercent } = input;

    if (!ACTIVE_CONTRACT_STATUSES.has(contract.status)) return false;
    if (!ACTIVE_PROJECT_STATUSES.has(contract.project.status)) return false;
    if (!contract.projectId || !contract.id) return false;
    if (!Number.isFinite(contract.durationDays) || contract.durationDays <= 0) {
      return false;
    }
    if (stages.length === 0) return false;
    if (progressPercent >= 100) return false;

    return true;
  }

  buildProjectHealthContext(
    input: BuildProjectOperationsContextInput
  ): ProjectOperationsContext | null {
    if (!this.isEligibleForProjectHealthAnalysis(input)) return null;

    const { actorRole, contract, stages, progressPercent } = input;
    const now = input.now ?? new Date();
    const startAt = contract.signedAt ?? contract.createdAt;
    const expectedEndAt = new Date(
      startAt.getTime() + contract.durationDays * MS_PER_DAY
    );
    const elapsedDays = daysBetween(startAt, now);
    const daysLeft = Math.max(0, contract.durationDays - elapsedDays);
    const overdueDays =
      now.getTime() > expectedEndAt.getTime()
        ? Math.ceil((now.getTime() - expectedEndAt.getTime()) / MS_PER_DAY)
        : 0;

    const deliveries = stages.flatMap(stage => stage.deliveries ?? []);
    const submittedCount = countByStatus(deliveries, 'SUBMITTED');
    const revisionRequestedCount = countByStatus(
      deliveries,
      'REVISION_REQUESTED'
    );
    const approvedDeliveryCount = countByStatus(deliveries, 'APPROVED');
    const lastSubmittedAt = deliveries
      .map(delivery => delivery.submittedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    const currentStage =
      stages.find(stage => stage.status === 'SUBMITTED') ??
      stages.find(stage => stage.status === 'REVISION_REQUESTED') ??
      stages.find(stage => stage.status === 'IN_PROGRESS') ??
      stages.find(stage => stage.status === 'PENDING') ??
      null;

    const escrowAmount = Number(contract.project.escrow?.amount ?? 0);
    const releasedAmount = Number(contract.project.escrow?.releasedAmount ?? 0);
    const stageRatings = stages.flatMap(stage =>
      (stage.stageReviews ?? []).map(review => review.rating)
    );
    const reviews = contract.project.reviews ?? [];
    const messages = (contract.project.conversations ?? [])
      .flatMap(conversation => conversation.messages ?? []);
    const lastMessageAt = messages
      .map(message => message.createdAt)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    return {
      project: {
        title: contract.project.title,
        descriptionExcerpt: capDescription(contract.project.description),
        status: contract.project.status,
        specialty: contract.project.specialty,
        subSpecialties: contract.project.subSpecialties ?? [],
        deliveryDays: contract.project.deliveryDays,
        createdAt: contract.project.createdAt.toISOString(),
        updatedAt: contract.project.updatedAt.toISOString(),
      },
      actor: { role: actorRole },
      contract: {
        status: contract.status,
        signedAt: toIso(contract.signedAt),
        durationDays: contract.durationDays,
        phasesCount: contract.phasesCount,
      },
      schedule: {
        elapsedDays,
        daysLeft,
        overdueDays,
        expectedEndAt: expectedEndAt.toISOString(),
      },
      progress: {
        percent: roundPercent(progressPercent),
        completedStages: countByStatus(stages, 'APPROVED'),
        totalStages: stages.length,
        pendingStages: countByStatus(stages, 'PENDING'),
        inProgressStages: countByStatus(stages, 'IN_PROGRESS'),
        submittedStages: countByStatus(stages, 'SUBMITTED'),
        revisionRequestedStages: countByStatus(stages, 'REVISION_REQUESTED'),
      },
      stages: stages.map(stage => ({
        stepOrder: stage.stepOrder,
        status: stage.status,
        days: stage.days,
        percentage: stage.percentage,
        startedAt: toIso(stage.startedAt),
        approvedAt: toIso(stage.approvedAt),
        deliveryCounts: {
          total: stage.deliveries.length,
          submitted: countByStatus(stage.deliveries, 'SUBMITTED'),
          revisionRequested: countByStatus(
            stage.deliveries,
            'REVISION_REQUESTED'
          ),
          approved: countByStatus(stage.deliveries, 'APPROVED'),
        },
      })),
      currentStage: currentStage
        ? {
            stepOrder: currentStage.stepOrder,
            status: currentStage.status,
            days: currentStage.days,
            percentage: currentStage.percentage,
          }
        : null,
      deliveries: {
        totalCount: deliveries.length,
        submittedCount,
        revisionRequestedCount,
        approvedCount: approvedDeliveryCount,
        lastSubmittedAt: toIso(lastSubmittedAt),
      },
      escrow: {
        status: contract.project.escrow?.status ?? null,
        releasedPercent:
          escrowAmount > 0 ? roundPercent((releasedAmount / escrowAmount) * 100) : 0,
        hasHeldFunds:
          contract.project.escrow?.status === 'HELD' &&
          Math.max(0, escrowAmount - releasedAmount) > 0,
      },
      disputes: {
        hasOpenDispute: (contract.project.disputes ?? []).some(
          dispute => dispute.status === 'OPEN'
        ),
        hasUnderReviewDispute: (contract.project.disputes ?? []).some(
          dispute => dispute.status === 'UNDER_REVIEW'
        ),
      },
      ratings: {
        hasFinalClientRating: reviews.some(
          review => review.reviewerRole === 'CLIENT' && !review.stageId
        ),
        hasFinalProviderRating: reviews.some(
          review => review.reviewerRole === 'PROVIDER' && !review.stageId
        ),
        averageStageRating: average(stageRatings),
      },
      proposal: {
        matchPercentage: null,
        qualityTag: null,
        priceTag: null,
      },
      communication: {
        messageCount: messages.length,
        lastMessageAt: toIso(lastMessageAt),
      },
    };
  }

  applyProjectHealthAnalysis(
    baseInsights: ProjectOperationsPublicAiInsights,
    analysis: ProjectHealthAnalysisAiOutput
  ): ProjectOperationsPublicAiInsights {
    const actionBullet = `الإجراء المقترح: ${analysis.recommendedAction.action}`;
    const bullets = [
      analysis.primaryReason,
      ...analysis.bullets.slice(0, 2),
      actionBullet,
    ];

    return {
      ...baseInsights,
      riskLevelKey: analysis.riskLevelKey,
      riskLevel: PROJECT_OPERATIONS_RISK_LABELS_AR[analysis.riskLevelKey],
      healthRating: analysis.healthRating,
      bullets,
    };
  }
}

export const projectOperationsContextService =
  new ProjectOperationsContextService();
