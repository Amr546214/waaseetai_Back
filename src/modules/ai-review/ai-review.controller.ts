import { Request, Response, NextFunction } from 'express';
import { AiReviewService } from './ai-review.service';
import { CompleteProjectDataDto, EnhanceDescriptionDto, SuggestTextDto, SuggestMilestonesDto } from './ai-review.dto';
import { AppError } from '../../utils/app-error';

export class AiReviewController {
  private service: AiReviewService;

  constructor() {
    this.service = new AiReviewService();
  }

  enhanceDescription = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto: EnhanceDescriptionDto = req.body;
      if (!dto.description && !dto.title) {
        return next(new AppError('Title or description is required for enhancement', 400));
      }

      const enhancedText = await this.service.enhanceDescription({
        title: dto.title || '',
        description: dto.description || ''
      });

      res.status(200).json({
        success: true,
        message: 'Description enhanced successfully',
        data: { text: enhancedText }
      });
    } catch (error) {
      next(error);
    }
  };

  suggestText = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto: SuggestTextDto = req.body;

      const suggestion = await this.service.suggestText({
        title: dto.title || ''
      });

      res.status(200).json({
        success: true,
        message: 'Text suggested successfully',
        data: { text: suggestion }
      });
    } catch (error) {
      next(error);
    }
  };

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
      }, req.user?.userId || req.user?.id);

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

      const analysis = await this.service.analyzeProjectModel(
        payload || {},
        req.user?.userId || req.user?.id
      );

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
