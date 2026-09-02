import { Request, Response, NextFunction } from 'express';
import { createRatingSchema } from '../dtos/rating.dto';
import { AppError } from '../utils/app-error';
import { ratingService } from '../services/rating.service';

export async function rateAsClient(req: Request, res: Response, next: NextFunction) {
  try { const parsed = createRatingSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات التقييم غير صحيحة', 400); res.status(201).json({ success: true, data: await ratingService.rateRequest(String(req.params.id), req.user!.id, 'client', parsed.data) }); } catch (error) { next(error); }
}

export async function rateAsProvider(req: Request, res: Response, next: NextFunction) {
  try { const parsed = createRatingSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات التقييم غير صحيحة', 400); res.status(201).json({ success: true, data: await ratingService.rateRequest(String(req.params.id), req.user!.id, 'provider', parsed.data) }); } catch (error) { next(error); }
}
