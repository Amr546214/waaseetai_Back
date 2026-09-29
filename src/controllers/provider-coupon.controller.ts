import { Request, Response, NextFunction } from 'express';
import { createCouponSchema, updateCouponSchema, couponApprovalDecisionSchema } from '../dtos/cart-checkout.dto';
import { providerCouponService } from '../services/provider-coupon.service';
import { AppError } from '../utils/app-error';
import { parsePaging } from '../services/marketing-stats.util';

const providerId = (req: Request) => req.user?.id || req.user?.userId;
const parse = (schema: any, body: unknown) => { const result = schema.safeParse(body); if (!result.success) throw new AppError('بيانات الكوبون غير صحيحة', 400); return result.data; };

export async function createCoupon(req: Request, res: Response, next: NextFunction) { try { res.status(201).json({ success: true, data: await providerCouponService.create(providerId(req)!, parse(createCouponSchema, req.body)) }); } catch (e) { next(e); } }
export async function listCoupons(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.list(providerId(req)!) }); } catch (e) { next(e); } }
export async function getCoupon(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.get(providerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
export async function updateCoupon(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.update(providerId(req)!, String(req.params.id), parse(updateCouponSchema, req.body)) }); } catch (e) { next(e); } }
export async function deactivateCoupon(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.remove(providerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
// Phase 5 — company-only approve/reject on a PENDING coupon. Strict
// PROVIDER_COMPANY enforcement happens in the route (requireCompanyAccount),
// not here.
export async function decideCouponApproval(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.decideApproval(providerId(req)!, String(req.params.id), parse(couponApprovalDecisionSchema, req.body)) }); } catch (e) { next(e); } }
// GET /provider/coupons/:id/stats — per-coupon usage stats (?page=&pageSize=).
export async function getCouponStats(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.getStats(providerId(req)!, String(req.params.id), parsePaging(req.query as any)) }); } catch (e) { next(e); } }
