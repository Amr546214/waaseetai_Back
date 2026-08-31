import { Request, Response, NextFunction } from 'express';
import { aiMatchingEngineService } from '../services/ai-matching-engine.service';

export const getTopMatchingProjects = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const providerId = (req as any).user?.id;
    if (!providerId) {
      return res.status(401).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }

    const matches = await aiMatchingEngineService.getTop3MatchingProjects(providerId);

    res.status(200).json({
      success: true,
      message: 'تم استخراج أفضل 3 عروض متناسبة بالذكاء الاصطناعي بنجاح',
      data: matches
    });
  } catch (error) {
    next(error);
  }
};
