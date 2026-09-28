import { z } from 'zod';

// Same numeric bounds as the existing Moyasar wallet deposit (client-finance
// service), now denominated in USD per this task's explicit PayPal-is-USD-only
// decision. No FX conversion — this is a deliberate reuse of the existing
// limit, not a derived/converted value.
export const createPaypalOrderSchema = z.object({
  amount: z.number().finite().min(50, 'الحد الأدنى للإيداع عبر PayPal هو 50').max(100000, 'الحد الأقصى للإيداع عبر PayPal هو 100,000')
});

export const capturePaypalOrderSchema = z.object({
  paypalOrderId: z.string().min(1, 'معرف طلب PayPal مطلوب')
});

export type CreatePaypalOrderDto = z.infer<typeof createPaypalOrderSchema>;
export type CapturePaypalOrderDto = z.infer<typeof capturePaypalOrderSchema>;
