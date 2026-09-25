import { Request, Response, NextFunction } from 'express';
import { AiReviewService } from './ai-review.service';
import { CompleteProjectDataDto, SuggestMilestonesDto } from './ai-review.dto';
import { AppError } from '../../utils/app-error';

export class AiReviewController {
  private service: AiReviewService;

  constructor() {
    this.service = new AiReviewService();
  }

  suggestMilestones = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto: SuggestMilestonesDto = req.body;
      if (!dto.title && !dto.description) {
        return next(new AppError('Title or description is required to suggest milestones', 400));
      }

      const milestones = await this.service.suggestMilestones({
        title: dto.title || '',
        description: dto.description || '',
        totalAmount: dto.totalAmount
      });

      res.status(200).json({
        success: true,
        message: 'Milestones suggested successfully by Waseet AI',
        data: { milestones }
      });
    } catch (error) {
      next(error);
    }
  };

  analyzeProjectModel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const payload: CompleteProjectDataDto = req.body;

      const analysis = await this.service.analyzeProjectModel(payload || {});

      res.status(200).json({
        success: true,
        message: 'Project model evaluated by Waseet AI successfully',
        data: analysis
      });
    } catch (error) {
      next(error);
    }
  };
}
