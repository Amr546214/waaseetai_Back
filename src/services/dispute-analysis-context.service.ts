import {
  ContractStatus,
  DisputeStatus,
  ProjectStageStatus,
  ProposalStatus,
  StageDeliveryStatus,
} from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import type {
  DisputeCaseAnalysisContext,
  DisputeClaimantRole,
  DisputeStageSignal,
} from '../modules/ai-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TITLE_LENGTH = 160;
const SCOPE_EXCERPT_LENGTH = 1000;
const DISPUTE_REASON_LENGTH = 120;
const DISPUTE_DESCRIPTION_LENGTH = 1500;
const SHORT_TEXT_LENGTH = 160;
const STAGE_TITLE_LENGTH = 120;
const DELIVERY_NOTE_LENGTH = 500;
const SUB_SPECIALTIES_LIMIT = 5;
const RELEVANT_STAGES_LIMIT = 10;
const DELIVERY_NOTE_EXCERPT_LIMIT = 3;

const REVIEWABLE_DISPUTE_STATUSES = new Set<DisputeStatus>([
  DisputeStatus.OPEN,
  DisputeStatus.UNDER_REVIEW,
]);

type EvidenceTypeKey =
  | 'pdf'
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'archive'
  | 'text'
  | 'other'
  | 'unknown';

type EvidenceTypeCounts = Record<EvidenceTypeKey, number>;

type DisputeStageFact = {
  stepOrder: number;
  title: string;
  status: ProjectStageStatus;
  days: number;
  percentage: number;
};

export interface DisputeCaseAnalysisFacts {
  dispute: {
    status: DisputeStatus;
    claimantRole: DisputeClaimantRole;
    ageDays: number;
    createdAt: string;
    evidenceUrlCount: number;
    claimantStatementAvailable: true;
    respondentStatementAvailable: false;
  };
  scope: {
    source: 'project' | 'client_request' | 'unavailable';
    status: string | null;
    specialtyAvailable: boolean;
    subSpecialtyCount: number;
  };
  contract: {
    status: ContractStatus | null;
    durationDays: number | null;
    signedAt: string | null;
    expectedEndAt: string | null;
  };
  schedule: {
    elapsedDays: number | null;
    daysLeft: number | null;
    overdueDays: number | null;
  };
  stages: {
    total: number;
    approved: number;
    pending: number;
    inProgress: number;
    submitted: number;
    revisionRequested: number;
    stageCompletionPercent: number;
  };
  deliveries: {
    total: number;
    submitted: number;
    revisionRequested: number;
    approved: number;
    revisionCount: number;
    latestSubmittedAt: string | null;
    noteExcerptCount: number;
  };
  evidence: {
    evidenceUrlCount: number;
    coarseTypeCounts: EvidenceTypeCounts;
    fileContentsInspected: false;
    evidenceUrlsSentToModel: false;
  };
  escrow: {
    status: string | null;
    releasedPercent: number | null;
  };
}

export interface DisputeCaseAnalysisAuditRefs {
  disputeId: string;
  projectId?: string;
  contractId?: string;
}

export interface DisputeCaseAnalysisContextBuildResult {
  context: DisputeCaseAnalysisContext;
  facts: DisputeCaseAnalysisFacts;
  auditRefs: DisputeCaseAnalysisAuditRefs;
}

const toIso = (value: Date | null | undefined): string | null => {
  return value ? value.toISOString() : null;
};

const redactSensitiveText = (value: string): string => {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted_email]')
    .replace(/\bSA\d{2}[A-Z0-9]{18}\b/gi, '[redacted_iban]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted_phone_or_id]');
};

const capText = (value: string | null | undefined, maxLength: number): string => {
  const trimmed = redactSensitiveText(value ?? '').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
};

const nullableCapText = (
  value: string | null | undefined,
  maxLength: number
): string | null => {
  const capped = capText(value, maxLength);
  return capped.length > 0 ? capped : null;
};

const capTextList = (
  values: string[] | null | undefined,
  maxLength: number,
  limit: number
): string[] => {
  return (values ?? [])
    .slice(0, limit)
    .map(value => capText(value, maxLength))
    .filter(Boolean);
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

const assertNonNegativeSafeInteger = (
  value: number,
  fieldName: string
): void => {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new AppError(`${fieldName} must be a non-negative safe integer.`, 400);
  }
};

const assertStagePercentage = (value: number, fieldName: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new AppError(`${fieldName} must be a finite percentage from 0 to 100.`, 400);
  }
};

const addDaysToDate = (
  startAt: Date,
  days: number,
  fieldName: string
): Date => {
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new AppError(`${fieldName} must be a positive safe integer.`, 400);
  }

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

const emptyEvidenceTypeCounts = (): EvidenceTypeCounts => ({
  pdf: 0,
  image: 0,
  document: 0,
  spreadsheet: 0,
  archive: 0,
  text: 0,
  other: 0,
  unknown: 0,
});

const evidenceTypeFromUrl = (value: string): EvidenceTypeKey => {
  let pathname = '';
  try {
    pathname = new URL(value).pathname.toLowerCase();
  } catch {
    return 'unknown';
  }

  const extension = pathname.split('.').pop() || '';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
  if (['doc', 'docx', 'rtf'].includes(extension)) return 'document';
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'spreadsheet';
  if (['zip', 'rar', '7z'].includes(extension)) return 'archive';
  if (['txt', 'md'].includes(extension)) return 'text';
  return extension ? 'other' : 'unknown';
};

const evidenceTypeCounts = (evidenceUrls: string[]): EvidenceTypeCounts => {
  const counts = emptyEvidenceTypeCounts();
  for (const evidenceUrl of evidenceUrls) {
    counts[evidenceTypeFromUrl(evidenceUrl)] += 1;
  }
  return counts;
};

const stageSignal = (stage: {
  stepOrder: number;
  title: string;
  status: ProjectStageStatus;
  days: number;
  percentage: number;
}): DisputeStageSignal => ({
  stepOrder: stage.stepOrder,
  title: capText(stage.title, STAGE_TITLE_LENGTH),
  status: stage.status,
  days: stage.days,
  percentage: stage.percentage,
});

const validateStageFact = (stage: DisputeStageFact): DisputeStageFact => {
  assertNonNegativeSafeInteger(stage.stepOrder, 'Project stage step order');
  assertNonNegativeSafeInteger(stage.days, 'Project stage days');
  assertStagePercentage(stage.percentage, 'Project stage percentage');

  return stage;
};

const deliveryNoteExcerpt = (delivery: {
  status: StageDeliveryStatus;
  submittedAt: Date;
  note: string | null | undefined;
}): {
  status: StageDeliveryStatus;
  submittedAt: string;
  noteExcerpt: string;
} | null => {
  const noteExcerpt = capText(delivery.note, DELIVERY_NOTE_LENGTH);
  if (!noteExcerpt) return null;

  return {
    status: delivery.status,
    submittedAt: delivery.submittedAt.toISOString(),
    noteExcerpt,
  };
};

const safeEscrowReleasedPercent = (
  escrow: { amount: number; releasedAmount: number } | null | undefined
): number | null => {
  if (!escrow) return null;

  const amount = Number(escrow.amount);
  const releasedAmount = Number(escrow.releasedAmount);
  if (!Number.isFinite(amount) || !Number.isFinite(releasedAmount)) {
    throw new AppError('Escrow release facts are invalid.', 400);
  }

  if (amount <= 0) return 0;

  return Math.min(100, Math.max(0, roundPercent((releasedAmount / amount) * 100)));
};

export class DisputeAnalysisContextService {
  async build(
    disputeId: string,
    now: Date = new Date()
  ): Promise<DisputeCaseAnalysisContextBuildResult> {
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        requestId: true,
        projectId: true,
        openedById: true,
        status: true,
        reason: true,
        description: true,
        evidence: true,
        resolvedAt: true,
        createdAt: true,
        request: {
          select: {
            title: true,
            description: true,
            status: true,
            subSpecialties: true,
            clientProfile: { select: { userId: true } },
            specialty: {
              select: {
                name: true,
                nameAr: true,
                nameEn: true,
              },
            },
            proposals: {
              where: { status: ProposalStatus.ACCEPTED },
              select: { providerId: true },
              take: 1,
            },
          },
        },
        project: {
          select: {
            title: true,
            description: true,
            status: true,
            specialty: true,
            subSpecialties: true,
            clientId: true,
            providerId: true,
          },
        },
      },
    });

    if (!dispute) {
      throw new AppError('النزاع غير موجود', 404);
    }

    if (!REVIEWABLE_DISPUTE_STATUSES.has(dispute.status)) {
      throw new AppError('لا يمكن تحليل نزاع تمت معالجته مسبقاً', 409);
    }

    const projectLookupId = dispute.projectId ?? dispute.requestId;
    const contract = projectLookupId
      ? await prisma.contract.findFirst({
          where: { projectId: projectLookupId },
          select: {
            id: true,
            projectId: true,
            clientId: true,
            providerId: true,
            status: true,
            durationDays: true,
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
                deliveryDays: true,
                clientId: true,
                providerId: true,
                escrow: {
                  select: {
                    status: true,
                    amount: true,
                    releasedAmount: true,
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
              },
            },
          },
        })
      : null;

    const [
      totalDeliveries,
      submittedDeliveries,
      revisionRequestedDeliveries,
      approvedDeliveries,
      latestDeliveries,
    ] = contract
      ? await Promise.all([
          prisma.stageDelivery.count({
            where: { stage: { contractId: contract.id } },
          }),
          prisma.stageDelivery.count({
            where: {
              status: StageDeliveryStatus.SUBMITTED,
              stage: { contractId: contract.id },
            },
          }),
          prisma.stageDelivery.count({
            where: {
              status: StageDeliveryStatus.REVISION_REQUESTED,
              stage: { contractId: contract.id },
            },
          }),
          prisma.stageDelivery.count({
            where: {
              status: StageDeliveryStatus.APPROVED,
              stage: { contractId: contract.id },
            },
          }),
          prisma.stageDelivery.findMany({
            where: {
              stage: { contractId: contract.id },
              note: { not: '' },
            },
            orderBy: [
              { submittedAt: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            take: DELIVERY_NOTE_EXCERPT_LIMIT,
            select: {
              status: true,
              submittedAt: true,
              note: true,
            },
          }),
        ])
      : [0, 0, 0, 0, []];

    const contractProject = contract?.project ?? null;
    const projectSource = contractProject ?? dispute.project;
    const requestSource = dispute.request;
    const scopeSource = projectSource
      ? 'project'
      : requestSource
        ? 'client_request'
        : 'unavailable';
    const title = nullableCapText(
      projectSource?.title ?? requestSource?.title,
      TITLE_LENGTH
    );
    const descriptionExcerpt = nullableCapText(
      projectSource?.description ?? requestSource?.description,
      SCOPE_EXCERPT_LENGTH
    );
    const specialty = nullableCapText(
      projectSource?.specialty ??
        requestSource?.specialty.nameAr ??
        requestSource?.specialty.name ??
        requestSource?.specialty.nameEn,
      SHORT_TEXT_LENGTH
    );
    const subSpecialties = capTextList(
      projectSource?.subSpecialties ?? requestSource?.subSpecialties,
      SHORT_TEXT_LENGTH,
      SUB_SPECIALTIES_LIMIT
    );
    const scopeStatus = projectSource?.status ?? requestSource?.status ?? null;
    const claimantRole = this.inferClaimantRole({
      openedById: dispute.openedById,
      requestClientId: requestSource?.clientProfile.userId,
      requestAcceptedProviderId: requestSource?.proposals[0]?.providerId,
      projectClientId: projectSource?.clientId,
      projectProviderId: projectSource?.providerId,
      contractClientId: contract?.clientId,
      contractProviderId: contract?.providerId,
    });

    const stages = (contract?.stages ?? []).map(validateStageFact);
    const approvedStages = countByStatus(stages, ProjectStageStatus.APPROVED);
    const pendingStages = countByStatus(stages, ProjectStageStatus.PENDING);
    const inProgressStages = countByStatus(stages, ProjectStageStatus.IN_PROGRESS);
    const submittedStages = countByStatus(stages, ProjectStageStatus.SUBMITTED);
    const revisionRequestedStages = countByStatus(
      stages,
      ProjectStageStatus.REVISION_REQUESTED
    );
    const approvedPercentageSum = stages
      .filter(stage => stage.status === ProjectStageStatus.APPROVED)
      .reduce((sum, stage) => sum + stage.percentage, 0);
    if (!Number.isFinite(approvedPercentageSum)) {
      throw new AppError('Project stage completion facts are invalid.', 400);
    }
    const stageCompletionPercent = Math.min(
      100,
      Math.max(0, Math.round(approvedPercentageSum))
    );
    const relevantStages = stages
      .filter(stage => stage.status !== ProjectStageStatus.APPROVED)
      .map(stageSignal)
      .slice(0, RELEVANT_STAGES_LIMIT);
    const currentStage =
      stages.find(stage => stage.status === ProjectStageStatus.SUBMITTED) ??
      stages.find(stage => stage.status === ProjectStageStatus.REVISION_REQUESTED) ??
      stages.find(stage => stage.status === ProjectStageStatus.IN_PROGRESS) ??
      stages.find(stage => stage.status === ProjectStageStatus.PENDING) ??
      null;

    const scheduleFacts = this.buildScheduleFacts(contract, now);
    const evidenceCounts = evidenceTypeCounts(dispute.evidence ?? []);
    const escrowReleasedPercent = safeEscrowReleasedPercent(
      contractProject?.escrow
    );
    const deliveryNoteExcerpts = latestDeliveries
      .map(deliveryNoteExcerpt)
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .slice(0, DELIVERY_NOTE_EXCERPT_LIMIT);
    const latestSubmittedAt = latestDeliveries[0]?.submittedAt ?? null;

    const facts: DisputeCaseAnalysisFacts = {
      dispute: {
        status: dispute.status,
        claimantRole,
        ageDays: daysBetween(dispute.createdAt, now),
        createdAt: dispute.createdAt.toISOString(),
        evidenceUrlCount: dispute.evidence.length,
        claimantStatementAvailable: true,
        respondentStatementAvailable: false,
      },
      scope: {
        source: scopeSource,
        status: scopeStatus,
        specialtyAvailable: Boolean(specialty),
        subSpecialtyCount: subSpecialties.length,
      },
      contract: {
        status: contract?.status ?? null,
        durationDays: contract?.durationDays ?? null,
        signedAt: toIso(contract?.signedAt),
        expectedEndAt: scheduleFacts.expectedEndAt,
      },
      schedule: {
        elapsedDays: scheduleFacts.elapsedDays,
        daysLeft: scheduleFacts.daysLeft,
        overdueDays: scheduleFacts.overdueDays,
      },
      stages: {
        total: stages.length,
        approved: approvedStages,
        pending: pendingStages,
        inProgress: inProgressStages,
        submitted: submittedStages,
        revisionRequested: revisionRequestedStages,
        stageCompletionPercent,
      },
      deliveries: {
        total: totalDeliveries,
        submitted: submittedDeliveries,
        revisionRequested: revisionRequestedDeliveries,
        approved: approvedDeliveries,
        revisionCount: revisionRequestedDeliveries,
        latestSubmittedAt: toIso(latestSubmittedAt),
        noteExcerptCount: deliveryNoteExcerpts.length,
      },
      evidence: {
        evidenceUrlCount: dispute.evidence.length,
        coarseTypeCounts: evidenceCounts,
        fileContentsInspected: false,
        evidenceUrlsSentToModel: false,
      },
      escrow: {
        status: contractProject?.escrow?.status ?? null,
        releasedPercent: escrowReleasedPercent,
      },
    };

    return {
      facts,
      auditRefs: {
        disputeId: dispute.id,
        ...(contract?.projectId && { projectId: contract.projectId }),
        ...(contract?.id && { contractId: contract.id }),
      },
      context: {
        case: {
          status: dispute.status,
          claimantRole,
          ageDays: facts.dispute.ageDays,
          createdAt: facts.dispute.createdAt,
          claimantStatementAvailable: true,
          respondentStatementAvailable: false,
          respondentPosition: 'not_available',
          claimantStatement: {
            reason: capText(dispute.reason, DISPUTE_REASON_LENGTH),
            description: capText(
              dispute.description,
              DISPUTE_DESCRIPTION_LENGTH
            ),
          },
          resolutionRecorded: Boolean(dispute.resolvedAt),
        },
        scope: {
          source: scopeSource,
          title,
          descriptionExcerpt,
          specialty,
          subSpecialties,
          status: scopeStatus,
        },
        contract: {
          status: facts.contract.status,
          durationDays: facts.contract.durationDays,
          signedAt: facts.contract.signedAt,
          expectedEndAt: facts.contract.expectedEndAt,
        },
        schedule: facts.schedule,
        stages: {
          ...facts.stages,
          current: currentStage ? stageSignal(currentStage) : null,
          relevant: relevantStages,
        },
        deliveries: {
          total: facts.deliveries.total,
          submitted: facts.deliveries.submitted,
          revisionRequested: facts.deliveries.revisionRequested,
          approved: facts.deliveries.approved,
          revisionCount: facts.deliveries.revisionCount,
          latestSubmittedAt: facts.deliveries.latestSubmittedAt,
          noteExcerpts: deliveryNoteExcerpts,
        },
        evidence: facts.evidence,
        escrow: facts.escrow,
        knownUnknowns: {
          respondentStatement: 'not_available',
          fileEvidenceContents: 'not_inspected',
          evidenceAuthenticity: 'not_assessed',
          legalLiability: 'not_determined_by_ai',
        },
      },
    };
  }

  private inferClaimantRole(input: {
    openedById: string;
    requestClientId?: string;
    requestAcceptedProviderId?: string;
    projectClientId?: string | null;
    projectProviderId?: string | null;
    contractClientId?: string;
    contractProviderId?: string;
  }): DisputeClaimantRole {
    if (
      input.openedById === input.contractClientId ||
      input.openedById === input.projectClientId ||
      input.openedById === input.requestClientId
    ) {
      return 'client';
    }

    if (
      input.openedById === input.contractProviderId ||
      input.openedById === input.projectProviderId ||
      input.openedById === input.requestAcceptedProviderId
    ) {
      return 'provider';
    }

    return 'unknown';
  }

  private buildScheduleFacts(
    contract:
      | {
          durationDays: number;
          signedAt: Date | null;
          createdAt: Date;
        }
      | null,
    now: Date
  ): {
    expectedEndAt: string | null;
    elapsedDays: number | null;
    daysLeft: number | null;
    overdueDays: number | null;
  } {
    if (!contract) {
      return {
        expectedEndAt: null,
        elapsedDays: null,
        daysLeft: null,
        overdueDays: null,
      };
    }

    const startAt = contract.signedAt ?? contract.createdAt;
    const expectedEndAt = addDaysToDate(
      startAt,
      contract.durationDays,
      'Contract duration'
    );
    const elapsedDays = daysBetween(startAt, now);
    const daysLeft = Math.max(0, contract.durationDays - elapsedDays);
    const overdueDays =
      now.getTime() > expectedEndAt.getTime()
        ? Math.ceil((now.getTime() - expectedEndAt.getTime()) / MS_PER_DAY)
        : 0;

    return {
      expectedEndAt: expectedEndAt.toISOString(),
      elapsedDays,
      daysLeft,
      overdueDays,
    };
  }
}

export const disputeAnalysisContextService =
  new DisputeAnalysisContextService();
