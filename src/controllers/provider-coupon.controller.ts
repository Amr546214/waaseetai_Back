import { Request, Response, NextFunction } from 'express';
import { createCouponSchema, updateCouponSchema } from '../dtos/cart-checkout.dto';
import { providerCouponService } from '../services/provider-coupon.service';
import { AppError } from '../utils/app-error';

const providerId = (req: Request) => req.user?.id || req.user?.userId;
const parse = (schema: any, body: unknown) => { const result = schema.safeParse(body); if (!result.success) throw new AppError('بيانات الكوبون غير صحيحة', 400); return result.data; };

export async function createCoupon(req: Request, res: Response, next: NextFunction) { try { res.status(201).json({ success: true, data: await providerCouponService.create(providerId(req)!, parse(createCouponSchema, req.body)) }); } catch (e) { next(e); } }
export async function listCoupons(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.list(providerId(req)!) }); } catch (e) { next(e); } }
export async function getCoupon(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.get(providerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
export async function updateCoupon(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.update(providerId(req)!, String(req.params.id), parse(updateCouponSchema, req.body)) }); } catch (e) { next(e); } }
export async function deactivateCoupon(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerCouponService.remove(providerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
