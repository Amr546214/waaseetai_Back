import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { adminCouponsService } from '../services/admin-coupons.service';
import { parsePaging } from '../services/marketing-stats.util';
import { AppError, zodAppError } from '../utils/app-error';

const adminId = (req: Request) => (req.user?.id || req.user?.userId)!;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const setActiveSchema = z.object({ active: z.boolean(), reason: z.string().trim().max(1000).optional().nullable() });

export const listCoupons = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query as any;
    res.json({ success: true, data: await adminCouponsService.list({ status: str(q.status), providerId: str(q.providerId), q: str(q.q) }, parsePaging(q)) });
  } catch (e) { next(e); }
};
export const getCoupon = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminCouponsService.get(String(req.params.id)) }); } catch (e) { next(e); }
};
export const setCouponActive = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = setActiveSchema.safeParse(req.body);
    if (!parsed.success) throw zodAppError(parsed.error.issues, 'بيانات غير صحيحة', { reason: 'سبب الإيقاف طويل جدًا (الحد الأقصى 1000 حرف)' });
    res.json({ success: true, data: await adminCouponsService.setActive(adminId(req), String(req.params.id), parsed.data) });
  } catch (e) { next(e); }
};
export const listSpecialOffers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query as any;
    res.json({ success: true, data: await adminCouponsService.listSpecialOffers({ status: str(q.status), providerId: str(q.providerId), q: str(q.q), type: str(q.type) }, parsePaging(q)) });
  } catch (e) { next(e); }
};
export const getSpecialOffer = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminCouponsService.getSpecialOffer(String(req.params.id)) }); } catch (e) { next(e); }
};
