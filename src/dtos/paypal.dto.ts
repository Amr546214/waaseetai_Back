import { z } from 'zod';

// PayPal is the only wallet deposit rail and is denominated in USD. The 50 / 100,000 bounds are the existing limits
// (no conversion); the owner may set the final USD values.
export const createPaypalOrderSchema = z.object({
  amount: z.number().finite().min(50, 'الحد الأدنى للإيداع عبر PayPal هو 50').max(100000, 'الحد الأقصى للإيداع عبر PayPal هو 100,000')
});

export const capturePaypalOrderSchema = z.object({
  paypalOrderId: z.string().min(1, 'معرف طلب PayPal مطلوب')
});

export type CreatePaypalOrderDto = z.infer<typeof createPaypalOrderSchema>;
export type CapturePaypalOrderDto = z.infer<typeof capturePaypalOrderSchema>;
