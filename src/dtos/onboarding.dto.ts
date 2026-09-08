import { z } from 'zod';

export const onboardingUploadSchema = z.object({
  documentType: z.enum(['national_id', 'commercial_registration', 'other']).default('national_id')
});

export const rejectOnboardingSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000, 'سبب الرفض مطلوب')
});

export type OnboardingUploadInput = z.infer<typeof onboardingUploadSchema>;
export type RejectOnboardingInput = z.infer<typeof rejectOnboardingSchema>;
