import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../utils/currency';

// PayPal is the only wallet deposit rail and is denominated in USD. The 50 / 100,000 bounds are the existing limits
// (no conversion); the owner may set the final USD values.
export const createPaypalOrderSchema = z.object({
  // the numeric bounds live in config/payment-gateways.ts (per gateway AND currency); the service enforces them. PayPal is enabled for USD only: any other currency is refused before a payment exists.
  amount: z.number().finite().positive('المبلغ غير صالح'),
  currency: z.enum(SUPPORTED_CURRENCIES).optional()
});

export const capturePaypalOrderSchema = z.object({
  paypalOrderId: z.string().min(1, 'معرف طلب PayPal مطلوب')
});

export type CreatePaypalOrderDto = z.infer<typeof createPaypalOrderSchema>;
export type CapturePaypalOrderDto = z.infer<typeof capturePaypalOrderSchema>;
