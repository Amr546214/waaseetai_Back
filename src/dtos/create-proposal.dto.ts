import { z } from 'zod';

export const createProposalMilestoneSchema = z.object({
  stepOrder: z.number().int().min(1, 'رقم المرحلة يجب أن يكون 1 على الأقل'),
  title: z.string().min(2, 'عنوان المرحلة يجب أن يكون حرفين على الأقل').max(100, 'عنوان المرحلة يتجاوز الحد الأقصى'),
  description: z.string().min(5, 'وصف المرحلة يجب أن يكون 5 أحرف على الأقل'),
  days: z.number().int().positive('عدد الأيام للمرحلة يجب أن يكون أكبر من الصفر'),
  percentage: z.number().positive('نسبة المرحلة يجب أن تكون أكبر من الصفر').max(100),
  amount: z.number().nonnegative('مبلغ المرحلة لا يمكن أن يكون سالباً')
});

export const createProposalSchema = z.object({
  title: z.string()
    .min(3, 'يجب أن يكون عنوان العرض 3 أحرف على الأقل')
    .max(80, 'يجب ألا يتجاوز عنوان العرض 80 حرفاً'),
  message: z.string()
    .min(30, 'يجب أن يكون وصف العرض 30 حرفاً على الأقل')
    .max(2000, 'يجب ألا يتجاوز وصف العرض 2000 حرف'),
  advantages: z.array(z.string()).max(10, 'لا يمكن إضافة أكثر من 10 نقاط قوة').optional().default([]),
  outputs: z.string().optional().default(''),
  portfolioIds: z.array(z.string()).optional().default([]),
  totalPrice: z.number().positive('يجب أن يكون السعر الإجمالي أكبر من صفر'),
  deliveryDays: z.number().int().positive('يجب أن تكون مدة التنفيذ يوماً واحداً على الأقل'),
  milestones: z.array(createProposalMilestoneSchema).min(1, 'يجب إضافة مرحلة عمل واحدة على الأقل'),
  agreedToTerms: z.boolean().refine(val => val === true, { message: 'يجب الموافقة على شروط المنصة' }),
  agreedToEscrow: z.boolean().refine(val => val === true, { message: 'يجب الموافقة على شروط الحجز المالي (Escrow)' })
}).superRefine((data, ctx) => {
  const totalPct = data.milestones.reduce((sum, m) => sum + m.percentage, 0);
  if (Math.abs(totalPct - 100) > 0.01) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `إجمالي نسب دفعات المراحل يجب أن يساوي 100% (المجموع الحالي: ${totalPct}%)`,
      path: ['milestones']
    });
  }
});

export type CreateProposalDto = z.infer<typeof createProposalSchema>;
export type CreateProposalMilestoneDto = z.infer<typeof createProposalMilestoneSchema>;
