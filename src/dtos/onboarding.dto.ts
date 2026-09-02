import { z } from 'zod';

export const onboardingUploadSchema = z.object({
  documentType: z.enum(['national_id', 'commercial_registration', 'other']).default('national_id')
});

export type OnboardingUploadInput = z.infer<typeof onboardingUploadSchema>;
