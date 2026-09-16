import { logger } from '../config/logger';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  ProjectHealthAnalysisAiOutput,
  ProjectOperationsContext,
} from '../modules/ai-engine';

export interface ProjectOperationsAuditRefs {
  actorUserId?: string;
  projectId: string;
  contractId?: string;
}

export class ProjectOperationsAiService {
  async analyzeProjectHealth(
    context: ProjectOperationsContext,
    auditRefs: ProjectOperationsAuditRefs
  ): Promise<ProjectHealthAnalysisAiOutput | null> {
    const result = await structuredAiExecutionService.execute<
      ProjectOperationsContext,
      ProjectHealthAnalysisAiOutput
    >({
      capability: 'project_operations',
      operation: 'project_health_analysis',
      input: context,
      locale: 'ar',
      auditContext: {
        ...(auditRefs.actorUserId && { actorUserId: auditRefs.actorUserId }),
        primaryEntity: { type: 'PROJECT', id: auditRefs.projectId },
        ...(auditRefs.contractId && {
          relatedEntities: [{ type: 'CONTRACT', id: auditRefs.contractId }],
        }),
      },
    });

    if (!result.success) {
      logger.warn(
        `[ProjectOperationsAiService] Optional project health analysis skipped for project ${auditRefs.projectId}. code=${result.error.code}`
      );
      return null;
    }

    return result.data;
  }
}

export const projectOperationsAiService = new ProjectOperationsAiService();
