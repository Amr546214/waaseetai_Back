import { NextFunction, Request, Response } from 'express';
import { specialtyPortfolioReviewService } from '../services/ai-features/specialty-portfolio-review.service';

// Advisory AI review of a provider's specialty portfolio (see specialty-portfolio-review.service.ts). The routes run provider auth and the
// ownership check first; the service re-checks ownership. Nothing here changes a specialty's status, tier or badge.
const userIdOf = (req: Request): string => String((req as any).user?.id ?? '');

export async function evaluateSpecialtyWithAI(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await specialtyPortfolioReviewService.evaluate(userIdOf(req), String(req.params.id));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
}

export async function getLatestSpecialtyAiEvaluation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await specialtyPortfolioReviewService.latest(userIdOf(req), String(req.params.id));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
}

export async function listSpecialtyAiEvaluations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await specialtyPortfolioReviewService.history(userIdOf(req), String(req.params.id));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
}
