import { z } from 'zod';

export const rejectAccreditationSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000, 'سبب الرفض مطلوب'),
  // admin-only note: never returned to the provider
  internalNote: z.string().trim().max(2000).optional()
});

// Batch B T1: «طلب استكمال» — the note addressed to the provider is mandatory, the fields to fix are optional, the internal note is admin-only.
export const requestCompletionSchema = z.object({
  userNote: z.string().trim().min(3, 'اكتب ملاحظة واضحة للمستخدم (3 أحرف على الأقل)').max(2000),
  internalNote: z.string().trim().max(2000).optional(),
  fields: z.array(z.string().trim().min(1).max(40)).max(12).optional()
});

export type RejectAccreditationInput = z.infer<typeof rejectAccreditationSchema>;

// BE-3(b): admin decision on a specialty stuck in UNDER_AI_REVIEW. A reason is mandatory for both outcomes.
export const specialtyReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().min(5, 'سبب القرار مطلوب (5 أحرف على الأقل)').max(2000)
});

export type SpecialtyReviewDecisionInput = z.infer<typeof specialtyReviewDecisionSchema>;
