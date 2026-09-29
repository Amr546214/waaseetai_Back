import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { marketingCenterService } from '../services/marketing-center.service';
import { AppError } from '../utils/app-error';

// Phase 7 — مركز التسويق. Mirrors provider-special-offer.controller.ts.
const providerId = (req: Request) => req.user?.id || req.user?.userId;

export const spendCapSchema = z.object({
  cap: z.number().finite().positive().max(100_000_000).nullable()
});

export async function getMarketingCenter(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await marketingCenterService.getCenter(providerId(req)!) }); } catch (e) { next(e); }
}

export async function updateMarketingSpendCap(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = spendCapSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'قيمة السقف غير صحيحة', 400);
    res.json({ success: true, data: await marketingCenterService.updateSpendCap(providerId(req)!, parsed.data.cap) });
  } catch (e) { next(e); }
}
