import { Request, Response, NextFunction } from 'express';
import { adminAiSummariesService } from '../services/ai-features/admin-ai-summaries.service';

type Kind = 'forecast' | 'anomaly' | 'sentiment';
// 200 {success:true, data: AiResult(+ deterministic fields)} for READY / NOT_ENOUGH_DATA / FAILED. Read-only.
const handler = (kind: Kind) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as any).user?.id as string;
    const data = await adminAiSummariesService[kind](adminId);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
export const getForecastSummary = handler('forecast');
export const getAnomalySummary = handler('anomaly');
export const getSentimentSummary = handler('sentiment');
