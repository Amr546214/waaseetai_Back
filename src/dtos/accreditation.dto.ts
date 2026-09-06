import { z } from 'zod';

export const rejectAccreditationSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000, 'سبب الرفض مطلوب')
});

export type RejectAccreditationInput = z.infer<typeof rejectAccreditationSchema>;
