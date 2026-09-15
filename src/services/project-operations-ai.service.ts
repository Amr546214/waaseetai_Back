import { logger } from '../config/logger';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  ProjectHealthAnalysisAiOutput,
  ProjectOperationsContext,
} from '../modules/ai-engine';

export class ProjectOperationsAiService {
  async analyzeProjectHealth(
    context: ProjectOperationsContext,
    actorUserId?: string
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
        ...(actorUserId && { actorUserId }),
        primaryEntity: { type: 'PROJECT', id: context.project.id },
      },
    });

    if (!result.success) {
      logger.warn(
        `[ProjectOperationsAiService] Optional project health analysis skipped for project ${context.project.id}. code=${result.error.code}`
      );
      return null;
    }

    return result.data;
  }
}

export const projectOperationsAiService = new ProjectOperationsAiService();
