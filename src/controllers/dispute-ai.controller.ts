import { Request, Response, NextFunction } from 'express';
import { disputeAiService } from '../services/dispute-ai.service';

const actorId = (req: Request) => req.user?.id || req.user?.userId!;

export async function analyzeDisputeCase(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await disputeAiService.analyzeDisputeCase(
      actorId(req),
      String(req.params.id)
    );

    res.status(200).json({
      success: true,
      message: 'AI dispute case analysis completed successfully.',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
