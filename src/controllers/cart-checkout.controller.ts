import { Request, Response, NextFunction } from 'express';
import { cartCheckoutService } from '../services/cart-checkout.service';
import { cartItemSchema, cartSyncSchema, checkoutOrderSchema, couponValidationSchema } from '../dtos/cart-checkout.dto';
import { z } from 'zod';
import { AppError } from '../utils/app-error';

const userId = (req: Request) => req.user?.id || req.user?.userId;

export async function getCart(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await cartCheckoutService.getCart(userId(req)!) }); } catch (error) { next(error); }
}

export async function addCartItem(req: Request, res: Response, next: NextFunction) {
  try { const parsed = cartItemSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات عنصر السلة غير صحيحة', 400); res.status(201).json({ success: true, data: await cartCheckoutService.addItem(userId(req)!, parsed.data) }); } catch (error) { next(error); }
}

export async function updateCartItem(req: Request, res: Response, next: NextFunction) {
  try { const parsed = cartItemSchema.partial().omit({ modelId: true }).safeParse(req.body); if (!parsed.success) throw new AppError('بيانات تحديث عنصر السلة غير صحيحة', 400); res.json({ success: true, data: await cartCheckoutService.updateItem(userId(req)!, String(req.params.id), parsed.data) }); } catch (error) { next(error); }
}

export async function deleteCartItem(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await cartCheckoutService.removeItem(userId(req)!, String(req.params.id)) }); } catch (error) { next(error); }
}

export async function syncCart(req: Request, res: Response, next: NextFunction) {
  try { const parsed = cartSyncSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات مزامنة السلة غير صحيحة', 400); res.json({ success: true, data: await cartCheckoutService.sync(userId(req)!, parsed.data.items) }); } catch (error) { next(error); }
}

export async function validateCoupon(req: Request, res: Response, next: NextFunction) {
  try { const parsed = couponValidationSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات الكوبون غير صحيحة', 400); res.json({ success: true, data: await cartCheckoutService.validateCoupon(parsed.data) }); } catch (error) { next(error); }
}

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try { const parsed = checkoutOrderSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات الطلب غير صحيحة', 400); res.status(201).json({ success: true, data: await cartCheckoutService.createOrder(userId(req)!, parsed.data) }); } catch (error) { next(error); }
}

export async function getOrder(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await cartCheckoutService.getOrder(userId(req)!, String(req.params.id)) }); } catch (error) { next(error); }
}

export async function getPaymentMethods(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await cartCheckoutService.getPaymentMethods(userId(req)!) }); } catch (error) { next(error); }
}

export async function initPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = z.object({ orderId: z.string().uuid(), paymentMethod: z.enum(['card', 'moyasar', 'wallet']) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('بيانات تهيئة الدفع غير صحيحة', 400);
    res.json({ success: true, data: await cartCheckoutService.initPayment(userId(req)!, parsed.data.orderId, parsed.data.paymentMethod) });
  } catch (error) { next(error); }
}

export async function confirmPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = z.object({ orderId: z.string().uuid(), otpCode: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('بيانات تأكيد الدفع غير صحيحة', 400);
    res.json({ success: true, data: await cartCheckoutService.confirmPayment(userId(req)!, parsed.data.orderId, parsed.data.otpCode) });
  } catch (error) { next(error); }
}

export async function resendPaymentOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = z.object({ orderId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) throw new AppError('orderId مطلوب', 400);
    res.json({ success: true, data: await cartCheckoutService.resendPaymentOtp(userId(req)!, parsed.data.orderId) });
  } catch (error) { next(error); }
}
