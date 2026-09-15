import {
  ContractStatus,
  DisputeStatus,
  ProjectStageStatus,
  ProjectStatus,
  StageDeliveryStatus,
} from '@prisma/client';
import { prisma } from '../config/db';
import { AmendmentAnalysisDto } from '../dtos/amendment-analysis.dto';
import { AppError } from '../utils/app-error';
import type { AmendmentAnalysisContext } from '../modules/ai-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SHORT_TEXT_LENGTH = 160;
const CURRENT_SCOPE_EXCERPT_LENGTH = 1000;
const PROPOSED_SCOPE_EXCERPT_LENGTH = 1200;
const SUB_SPECIALTIES_LIMIT = 5;
const REMAINING_STAGES_LIMIT = 10;

const ELIGIBLE_PROJECT_STATUSES = new Set<ProjectStatus>([
  ProjectStatus.IN_PROGRESS,
  ProjectStatus.AWAITING_DELIVERY,
  ProjectStatus.PENDING_REVIEW,
]);

export interface AmendmentImpactFacts {
  project: {
    id: string;
    status: ProjectStatus;
    progressPercent: number;
    remainingStages: number;
  };
  contract: {
    id: string;
    status: ContractStatus;
    currentPrice: number;
    durationDays: number;
    signedAt: string | null;
    expectedEndAt: string | null;
  };
  budget: {
    requestedDelta: number | null;
    proposedPrice: number | null;
    deltaPercent: number | null;
  };
  duration: {
    requestedDeltaDays: number | null;
    proposedDurationDays: number | null;
    deltaPercent: number | null;
  };
  schedule: {
    elapsedDays: number;
    daysLeft: number;
    overdueDays: number;
  };
  operationalSignals: {
    stageCounts: {
      total: number;
      approved: number;
      pending: number;
      inProgress: number;
      submitted: number;
      revisionRequested: number;
    };
    deliveryCounts: {
      total: number;
      submitted: number;
      revisionRequested: number;
      approved: number;
    };
    revisionCount: number;
    escrowStatus: string | null;
    escrowReleasedPercent: number;
    hasOpenDispute: boolean;
    hasUnderReviewDispute: boolean;
  };
}

export interface AmendmentAnalysisContextBuildResult {
  context: AmendmentAnalysisContext;
  facts: AmendmentImpactFacts;
}

const toIso = (value: Date | null | undefined): string | null => {
  return value ? value.toISOString() : null;
};

const capText = (value: string | null | undefined, maxLength: number): string => {
  const trimmed = (value ?? '').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
};

const capTextList = (
  values: string[] | null | undefined,
  maxLength: number,
  limit: number
): string[] => {
  return (values ?? [])
    .slice(0, limit)
    .map(value => capText(value, maxLength));
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

const roundPercent = (value: number): number => {
  return Math.round(value * 10) / 10;
};

const toSafeCents = (amount: number, fieldName: string): number => {
  if (!Number.isFinite(amount)) {
    throw new AppError(`${fieldName} must be a finite monetary value.`, 400);
  }

  const scaled = amount * 100;
  if (!Number.isFinite(scaled)) {
    throw new AppError(`${fieldName} is too large for safe cents conversion.`, 400);
  }

  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents)) {
    throw new AppError(`${fieldName} is not safely representable in cents.`, 400);
  }

  return cents;
};

const fromCents = (amountInCents: number): number => {
  return amountInCents / 100;
};

const assertSafePositiveDurationDays = (
  value: number,
  fieldName: string
): number => {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new AppError(`${fieldName} must be a positive safe integer.`, 400);
  }

  return value;
};

const assertSafeDurationDeltaDays = (
  value: number,
  fieldName: string
): number => {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value)
  ) {
    throw new AppError(`${fieldName} must be a safe integer.`, 400);
  }

  return value;
};

const addDaysToDate = (
  startAt: Date,
  days: number,
  fieldName: string
): Date => {
  const startTimestamp = startAt.getTime();
  if (!Number.isFinite(startTimestamp)) {
    throw new AppError(`${fieldName} start date is invalid.`, 400);
  }

  const expectedEndTimestamp = startTimestamp + days * MS_PER_DAY;
  const expectedEndAt = new Date(expectedEndTimestamp);
  if (
    !Number.isFinite(expectedEndTimestamp) ||
    !Number.isFinite(expectedEndAt.getTime())
  ) {
    throw new AppError(`${fieldName} date calculation is invalid.`, 400);
  }

  return expectedEndAt;
};

const safeRoundPercent = (value: number): number => {
  return Number.isFinite(value) ? roundPercent(value) : 0;
};

const stageSignal = (
  stage: {
    stepOrder: number;
    title: string;
    status: ProjectStageStatus;
    days: number;
    percentage: number;
  }
) => ({
  stepOrder: stage.stepOrder,
  title: capText(stage.title, 120),
  status: stage.status,
  days: stage.days,
  percentage: stage.percentage,
});

export class AmendmentAnalysisContextService {
  async build(
    userId: string,
    projectId: string,
    dto: AmendmentAnalysisDto,
    now: Date = new Date()
  ): Promise<AmendmentAnalysisContextBuildResult> {
    const contract = await prisma.contract.findFirst({
      where: {
        projectId,
        OR: [{ clientId: userId }, { providerId: userId }],
      },
      select: {
        id: true,
        projectId: true,
        clientId: true,
        providerId: true,
        price: true,
        durationDays: true,
        status: true,
        signedAt: true,
        createdAt: true,
        project: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            specialty: true,
            subSpecialties: true,
            escrow: {
              select: {
                status: true,
                amount: true,
                releasedAmount: true,
              },
            },
            disputes: {
              select: {
                status: true,
              },
            },
          },
        },
        stages: {
          orderBy: { stepOrder: 'asc' },
          select: {
            stepOrder: true,
            title: true,
            status: true,
            days: true,
            percentage: true,
            deliveries: {
              select: {
                status: true,
                submittedAt: true,
              },
            },
          },
        },
      },
    });

    if (!contract) {
      throw new AppError(
        'Project contract not found or you do not have access to it.',
        404
      );
    }

    if (contract.status !== ContractStatus.ACTIVE) {
      throw new AppError(
        'AI amendment analysis is available only for active contracts.',
        409
      );
    }

    if (!ELIGIBLE_PROJECT_STATUSES.has(contract.project.status)) {
      throw new AppError(
        'AI amendment analysis is available only for operational projects.',
        409
      );
    }

    const requesterRole = contract.clientId === userId ? 'client' : 'provider';
    const startAt = contract.signedAt ?? contract.createdAt;
    const currentDurationDays = assertSafePositiveDurationDays(
      contract.durationDays,
      'Current contract duration'
    );
    const expectedEndAt = addDaysToDate(
      startAt,
      currentDurationDays,
      'Current contract duration'
    );
    const elapsedDays = daysBetween(startAt, now);
    const daysLeft = Math.max(0, currentDurationDays - elapsedDays);
    const overdueDays =
      now.getTime() > expectedEndAt.getTime()
        ? Math.ceil((now.getTime() - expectedEndAt.getTime()) / MS_PER_DAY)
        : 0;

    const currentPriceCents = toSafeCents(
      contract.price,
      'Current contract price'
    );
    if (currentPriceCents <= 0) {
      throw new AppError('Current contract price must be greater than zero.', 400);
    }

    const requestedBudgetDeltaCents =
      dto.requestedBudgetDelta === undefined
        ? null
        : toSafeCents(dto.requestedBudgetDelta, 'Requested budget delta');
    const requestedBudgetDelta =
      requestedBudgetDeltaCents === null
        ? null
        : fromCents(requestedBudgetDeltaCents);
    const proposedPriceCents =
      requestedBudgetDeltaCents === null
        ? null
        : currentPriceCents + requestedBudgetDeltaCents;

    if (
      proposedPriceCents !== null &&
      (!Number.isSafeInteger(proposedPriceCents) || proposedPriceCents <= 0)
    ) {
      throw new AppError('Proposed contract price must remain greater than zero.', 400);
    }
    const proposedPrice =
      proposedPriceCents === null ? null : fromCents(proposedPriceCents);

    const requestedDurationDeltaDays =
      dto.requestedDurationDeltaDays === undefined
        ? null
        : assertSafeDurationDeltaDays(
            dto.requestedDurationDeltaDays,
            'Requested duration delta'
          );
    const proposedDurationDays =
      requestedDurationDeltaDays === null
        ? null
        : currentDurationDays + requestedDurationDeltaDays;

    if (
      proposedDurationDays !== null &&
      (!Number.isSafeInteger(proposedDurationDays) || proposedDurationDays <= 0)
    ) {
      throw new AppError(
        'Proposed contract duration must remain at least one day.',
        400
      );
    }
    if (proposedDurationDays !== null) {
      addDaysToDate(startAt, proposedDurationDays, 'Proposed contract duration');
    }

    const approvedStages = countByStatus(contract.stages, ProjectStageStatus.APPROVED);
    const progressPercent = Math.min(
      100,
      Math.max(
        0,
        Math.round(
          contract.stages
            .filter(stage => stage.status === ProjectStageStatus.APPROVED)
            .reduce((sum, stage) => sum + stage.percentage, 0)
        )
      )
    );
    const pendingStages = countByStatus(contract.stages, ProjectStageStatus.PENDING);
    const inProgressStages = countByStatus(
      contract.stages,
      ProjectStageStatus.IN_PROGRESS
    );
    const submittedStages = countByStatus(
      contract.stages,
      ProjectStageStatus.SUBMITTED
    );
    const revisionRequestedStages = countByStatus(
      contract.stages,
      ProjectStageStatus.REVISION_REQUESTED
    );
    const remainingStageSignals = contract.stages
      .filter(stage => stage.status !== ProjectStageStatus.APPROVED)
      .map(stageSignal);
    const currentStage =
      contract.stages.find(stage => stage.status === ProjectStageStatus.SUBMITTED) ??
      contract.stages.find(
        stage => stage.status === ProjectStageStatus.REVISION_REQUESTED
      ) ??
      contract.stages.find(stage => stage.status === ProjectStageStatus.IN_PROGRESS) ??
      contract.stages.find(stage => stage.status === ProjectStageStatus.PENDING) ??
      null;

    const deliveries = contract.stages.flatMap(stage => stage.deliveries);
    const submittedDeliveries = countByStatus(
      deliveries,
      StageDeliveryStatus.SUBMITTED
    );
    const revisionRequestedDeliveries = countByStatus(
      deliveries,
      StageDeliveryStatus.REVISION_REQUESTED
    );
    const approvedDeliveries = countByStatus(deliveries, StageDeliveryStatus.APPROVED);
    const lastSubmittedAt =
      deliveries
        .map(delivery => delivery.submittedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const escrowAmount = contract.project.escrow?.amount ?? 0;
    const escrowReleased = contract.project.escrow?.releasedAmount ?? 0;
    const escrowReleasedPercent =
      Number.isFinite(escrowAmount) &&
      Number.isFinite(escrowReleased) &&
      escrowAmount > 0
        ? safeRoundPercent((escrowReleased / escrowAmount) * 100)
        : 0;
    const openStatuses = Array.from(
      new Set(
        contract.project.disputes
          .map(dispute => dispute.status)
          .filter(
            status =>
              status === DisputeStatus.OPEN ||
              status === DisputeStatus.UNDER_REVIEW
          )
      )
    );

    const budgetDeltaPercent =
      requestedBudgetDeltaCents !== null && currentPriceCents > 0
        ? roundPercent((requestedBudgetDeltaCents / currentPriceCents) * 100)
        : null;
    const durationDeltaPercent =
      requestedDurationDeltaDays !== null && currentDurationDays > 0
        ? roundPercent((requestedDurationDeltaDays / currentDurationDays) * 100)
        : null;

    const facts: AmendmentImpactFacts = {
      project: {
        id: contract.project.id,
        status: contract.project.status,
        progressPercent,
        remainingStages: remainingStageSignals.length,
      },
      contract: {
        id: contract.id,
        status: contract.status,
        currentPrice: fromCents(currentPriceCents),
        durationDays: currentDurationDays,
        signedAt: toIso(contract.signedAt),
        expectedEndAt: expectedEndAt.toISOString(),
      },
      budget: {
        requestedDelta: requestedBudgetDelta,
        proposedPrice,
        deltaPercent: budgetDeltaPercent,
      },
      duration: {
        requestedDeltaDays: requestedDurationDeltaDays,
        proposedDurationDays,
        deltaPercent: durationDeltaPercent,
      },
      schedule: {
        elapsedDays,
        daysLeft,
        overdueDays,
      },
      operationalSignals: {
        stageCounts: {
          total: contract.stages.length,
          approved: approvedStages,
          pending: pendingStages,
          inProgress: inProgressStages,
          submitted: submittedStages,
          revisionRequested: revisionRequestedStages,
        },
        deliveryCounts: {
          total: deliveries.length,
          submitted: submittedDeliveries,
          revisionRequested: revisionRequestedDeliveries,
          approved: approvedDeliveries,
        },
        revisionCount: revisionRequestedDeliveries,
        escrowStatus: contract.project.escrow?.status ?? null,
        escrowReleasedPercent,
        hasOpenDispute: openStatuses.includes(DisputeStatus.OPEN),
        hasUnderReviewDispute: openStatuses.includes(DisputeStatus.UNDER_REVIEW),
      },
    };

    const contractContext = {
      status: facts.contract.status,
      currentPrice: facts.contract.currentPrice,
      durationDays: facts.contract.durationDays,
      signedAt: facts.contract.signedAt,
      expectedEndAt: facts.contract.expectedEndAt,
    };

    return {
      facts,
      context: {
        project: {
          title: capText(contract.project.title, SHORT_TEXT_LENGTH),
          status: contract.project.status,
          specialty: capText(contract.project.specialty, SHORT_TEXT_LENGTH),
          subSpecialties: capTextList(
            contract.project.subSpecialties,
            SHORT_TEXT_LENGTH,
            SUB_SPECIALTIES_LIMIT
          ),
          progressPercent,
          remainingStages: remainingStageSignals.length,
          currentScopeExcerpt: capText(
            contract.project.description,
            CURRENT_SCOPE_EXCERPT_LENGTH
          ),
        },
        actor: { requesterRole },
        contract: contractContext,
        proposedChange: {
          scopeChange: dto.scopeChange
            ? capText(dto.scopeChange, PROPOSED_SCOPE_EXCERPT_LENGTH)
            : null,
          requestedBudgetDelta,
          proposedPrice,
          budgetDeltaPercent,
          requestedDurationDeltaDays,
          proposedDurationDays,
          durationDeltaPercent,
        },
        schedule: facts.schedule,
        stages: {
          ...facts.operationalSignals.stageCounts,
          current: currentStage ? stageSignal(currentStage) : null,
          remaining: remainingStageSignals.slice(0, REMAINING_STAGES_LIMIT),
        },
        deliveries: {
          ...facts.operationalSignals.deliveryCounts,
          lastSubmittedAt: toIso(lastSubmittedAt),
        },
        escrow: {
          status: facts.operationalSignals.escrowStatus,
          releasedPercent: escrowReleasedPercent,
        },
        disputes: {
          hasOpenDispute: facts.operationalSignals.hasOpenDispute,
          hasUnderReviewDispute:
            facts.operationalSignals.hasUnderReviewDispute,
          openStatuses,
        },
      },
    };
  }
}

export const amendmentAnalysisContextService =
  new AmendmentAnalysisContextService();
