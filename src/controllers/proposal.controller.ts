import { Request, Response, NextFunction } from 'express';
import { proposalService } from '../services/proposal.service';
import { aiProposalService } from '../services/ai-proposal.service';
import { CreateProposalDto } from '../dtos/create-proposal.dto';
import { AiSuggestRequestDto } from '../dtos/ai-suggest-request.dto';

export class ProposalController {
  /**
   * Handle provider proposal creation & submission for a project
   * Route: POST /api/projects/:id/proposals
   */
  public async createProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const projectId = req.params.id as string;
      const providerId = req.user!.userId;
      const payload: CreateProposalDto = req.body;

      const newProposal = await proposalService.createProposal(projectId, providerId, payload);

      res.status(201).json({
        success: true,
        message: 'تم إرسال عرضك بنجاح وبدأت مرحلة التحقق الذكي عبر وسيط AI',
        data: newProposal
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Handle interactive AI refinement and evaluation for proposal application wizard
   * Route: POST /api/proposals/ai-suggest
   */
  public async aiSuggest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId, currentTitle, currentMessage, advantages }: AiSuggestRequestDto = req.body;

      const suggestions = await aiProposalService.evaluateAndSuggestProposal(
        projectId,
        currentTitle,
        currentMessage,
        advantages,
        {
          actorUserId: req.user?.userId || req.user?.id,
          primaryEntity: { type: 'PROJECT', id: projectId },
        }
      );

      res.status(200).json({
        success: true,
        message: 'تم تحليل العرض واقتراح التحسينات الذكية بنجاح',
        data: suggestions
      });
    } catch (error) {
      next(error);
    }
  }
}

export const proposalController = new ProposalController();
export default proposalController;
