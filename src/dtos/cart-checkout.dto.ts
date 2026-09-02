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

const couponFieldsSchema = z.object({
  code: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/).transform(value => value.toUpperCase()),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.number().positive(),
  serviceIds: z.array(z.string().uuid()).min(1).max(50),
  minimumAmount: z.number().nonnegative().optional().nullable(),
  maxDiscount: z.number().positive().optional().nullable(),
  maxUses: z.number().int().positive().optional().nullable(),
  maxUsesPerUser: z.number().int().positive().optional().default(1),
  startAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional().nullable()
});

export const createCouponSchema = couponFieldsSchema.superRefine((value, ctx) => {
  if (value.discountType === 'percentage' && value.discountValue > 100) {
    ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'النسبة يجب أن تكون بين 1 و100' });
  }
  if (value.expiresAt && value.startAt && value.expiresAt <= value.startAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية' });
  }
});

export const updateCouponSchema = couponFieldsSchema.partial().extend({ active: z.boolean().optional() }).superRefine((value, ctx) => {
  if (value.discountType === 'percentage' && value.discountValue !== undefined && value.discountValue > 100) {
    ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'النسبة يجب أن تكون بين 1 و100' });
  }
  if (value.expiresAt && value.startAt && value.expiresAt <= value.startAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية' });
  }
});
