import { prisma } from '../utils/prisma.client';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { ProjectStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  AiAuditEntityRef,
  AiEngineErrorPayload,
  ProposalFeedbackAiOutput,
  ProposalFeedbackPromptInput,
  ProposalFeedbackProjectContext,
} from '../modules/ai-engine';

export interface AiPriceAudit {
  recommendedMin: number;
  recommendedMax: number;
  priceTag: 'UNDERPRICED' | 'FAIR' | 'OVERPRICED';
  justification: string;
}

export interface AiProposalFeedback {
  suggestedTitle: string;
  suggestedMessage: string;
  qualityScore: number;
  qualityTag: 'POOR' | 'MEDIUM' | 'GOOD' | 'EXCELLENT';
  priceAudit: AiPriceAudit;
  recommendedAdvantages: string[];
}

export interface ProposalEvaluationOptions {
  actorUserId?: string;
  primaryEntity?: AiAuditEntityRef;
}

type ProposalFeedbackOperation =
  | 'proposal_feedback'
  | 'proposal_submission_evaluation';

const getAiFailureStatusCode = (error: AiEngineErrorPayload): number => {
  if (error.code === 'AI_PROVIDER_RATE_LIMITED') return 429;
  if (
    error.code === 'AI_RESPONSE_VALIDATION_FAILED' ||
    error.code === 'AI_PROVIDER_BAD_RESPONSE'
  ) return 502;

  return error.statusCode && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : 503;
};

const createAiFailureAppError = (
  message: string,
  error: AiEngineErrorPayload
): AppError => {
  return new AppError(message, getAiFailureStatusCode(error), [error]);
};

class AiProposalService {
  /**
   * Evaluates the provider's draft proposal against targeted project specs and fails closed
   * for the explicit AI suggestion endpoint.
   */
  public async evaluateAndSuggestProposal(
    projectId: string,
    actorUserId: string,
    currentTitle?: string,
    currentMessage?: string,
    advantages: string[] = [],
    options: ProposalEvaluationOptions = {}
  ): Promise<AiProposalFeedback> {
    const result = await this.executeProposalFeedback(
      projectId,
      currentTitle,
      currentMessage,
      advantages,
      {
        ...options,
        actorUserId,
      },
      'proposal_feedback',
      actorUserId
    );

    if (!result.success) {
      throw createAiFailureAppError(
        'AI proposal evaluation failed. No simulated proposal feedback was returned.',
        result.error
      );
    }

    return result.data;
  }

  /**
   * Proposal submission may proceed without optional AI enrichment.
   */
  public async evaluateProposalForSubmission(
    projectId: string,
    providerId: string,
    currentTitle?: string,
    currentMessage?: string,
    advantages: string[] = [],
    primaryEntity?: AiAuditEntityRef
  ): Promise<AiProposalFeedback | null> {
    const result = await this.executeProposalFeedback(
      projectId,
      currentTitle,
      currentMessage,
      advantages,
      {
        actorUserId: providerId,
        primaryEntity,
      },
      'proposal_submission_evaluation'
    );

    if (!result.success) {
      logger.warn(
        `[AiProposalService] Optional proposal AI enrichment skipped for project ${projectId}. code=${result.error.code}`
      );
      return null;
    }

    return result.data;
  }

  private async executeProposalFeedback(
    projectId: string,
    currentTitle?: string,
    currentMessage?: string,
    advantages: string[] = [],
    options: ProposalEvaluationOptions = {},
    operation: ProposalFeedbackOperation = 'proposal_feedback',
    accessActorUserId?: string
  ) {
    if (accessActorUserId) {
      await this.assertCanAccessProjectForAiSuggestion(projectId, accessActorUserId);
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        title: true,
        description: true,
        budgetMin: true,
        budgetMax: true,
        budgetFixed: true,
        deliveryDays: true,
        requirements: true,
        specialty: true
      }
    });

    if (!project) {
      throw this.createProjectAccessError();
    }

    const defaultMin = Number(project.budgetMin ?? project.budgetFixed ?? 3000);
    const defaultMax = Number(project.budgetMax ?? project.budgetFixed ?? 6000);

    const projectContext: ProposalFeedbackProjectContext = {
      title: project.title,
      description: project.description,
      specialty: project.specialty,
      requirements: project.requirements || [],
      deliveryDays: project.deliveryDays,
      defaultMinBudget: defaultMin,
      defaultMaxBudget: defaultMax,
    };

    const input: ProposalFeedbackPromptInput = {
      project: projectContext,
      currentTitle,
      currentMessage,
      advantages,
    };

    return structuredAiExecutionService.execute<
      ProposalFeedbackPromptInput,
      ProposalFeedbackAiOutput
    >({
      capability: 'proposals',
      operation,
      input,
      locale: 'ar',
      auditContext: {
        ...(options.actorUserId && { actorUserId: options.actorUserId }),
        primaryEntity: options.primaryEntity ?? { type: 'PROJECT', id: projectId },
      },
    });
  }

  private createProjectAccessError(): AppError {
    return new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
  }

  private normalizeSpecialty(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private async providerCanSeeOpenProject(
    providerId: string,
    projectSpecialty: string | null
  ): Promise<boolean> {
    const normalizedProjectSpecialty = this.normalizeSpecialty(projectSpecialty);
    if (!normalizedProjectSpecialty) return false;

    const providerProfile = await prisma.providerProfile.findUnique({
      where: { userId: providerId },
      include: {
        providerSpecialties: {
          where: {
            isActive: true,
            status: SpecialtyVerificationStatus.APPROVED,
          },
          include: { specialty: true },
        },
      },
    });

    const providerSpecialties = providerProfile?.providerSpecialties || [];
    const providerSpecialtyIds = providerSpecialties
      .map(providerSpecialty => providerSpecialty.specialtyId)
      .filter(Boolean);

    if (providerSpecialtyIds.length === 0) return false;

    const providerKeywords = new Set(
      providerSpecialties
        .flatMap(providerSpecialty => [
          providerSpecialty.specialty?.nameAr,
          providerSpecialty.specialty?.name,
          providerSpecialty.specialty?.nameEn,
          ...(providerSpecialty.subSpecialties || []),
        ])
        .map(value => this.normalizeSpecialty(value))
        .filter((value): value is string => Boolean(value))
    );

    return providerKeywords.has(normalizedProjectSpecialty);
  }

  private async assertCanAccessProjectForAiSuggestion(
    projectId: string,
    actorUserId: string
  ): Promise<void> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        status: true,
        specialty: true,
        providerId: true,
        contract: {
          select: {
            providerId: true,
          },
        },
        projectProposals: {
          where: { providerId: actorUserId },
          select: { id: true },
          take: 1,
        },
        proposals: {
          where: { providerId: actorUserId },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!project) {
      throw this.createProjectAccessError();
    }

    if (project.providerId === actorUserId || project.contract?.providerId === actorUserId) {
      return;
    }

    if (project.projectProposals.length > 0 || project.proposals.length > 0) {
      return;
    }

    if (
      project.status === ProjectStatus.OPEN &&
      await this.providerCanSeeOpenProject(actorUserId, project.specialty)
    ) {
      return;
    }

    throw this.createProjectAccessError();
  }
}

export const aiProposalService = new AiProposalService();
export default aiProposalService;
