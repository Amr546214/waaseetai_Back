import { z } from 'zod';

export const rejectAccreditationSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000, 'سبب الرفض مطلوب')
});

export type RejectAccreditationInput = z.infer<typeof rejectAccreditationSchema>;

// BE-3(b): admin decision on a specialty stuck in UNDER_AI_REVIEW. A reason is mandatory for both outcomes.
export const specialtyReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().min(5, 'سبب القرار مطلوب (5 أحرف على الأقل)').max(2000)
});

export type SpecialtyReviewDecisionInput = z.infer<typeof specialtyReviewDecisionSchema>;
