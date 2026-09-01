import { z } from 'zod';

export const cartItemSchema = z.object({
  modelId: z.string().uuid(),
  packageId: z.string().min(1).max(50).optional(),
  savedForLater: z.boolean().optional()
});

export const cartSyncSchema = z.object({
  items: z.array(cartItemSchema).max(50)
});

export const couponValidationSchema = z.object({
  code: z.string().trim().min(1).max(50),
  items: z.array(z.object({ modelId: z.string().uuid(), totalAmount: z.number().nonnegative() })).min(1).max(50)
});

export const checkoutOrderSchema = z.object({
  items: z.array(z.object({ modelId: z.string().uuid(), packageId: z.string().min(1).max(50).optional() })).min(1).max(50),
  couponCode: z.string().trim().min(1).max(50).optional().nullable()
});
