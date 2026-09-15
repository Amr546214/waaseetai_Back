import { Request, Response, NextFunction } from 'express';
import { AmendmentAnalysisDto } from '../dtos/amendment-analysis.dto';
import { amendmentAiService } from '../services/amendment-ai.service';

export class ProjectAmendmentsController {
  public async analyzeAmendmentImpact(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const projectId = req.params.id as string;
      const userId = req.user!.userId || req.user!.id;
      const payload: AmendmentAnalysisDto = req.body;

      const result = await amendmentAiService.analyzeAmendmentImpact(
        userId,
        projectId,
        payload
      );

      res.status(200).json({
        success: true,
        message: 'AI amendment impact analysis completed successfully.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const projectAmendmentsController =
  new ProjectAmendmentsController();
