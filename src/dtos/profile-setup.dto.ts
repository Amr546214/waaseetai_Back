import { z } from 'zod';

export const profileSetupSchema = z.object({
  // Preferences / Basic Info
  avatarUrl: z.string().url().optional().nullable(),
  phoneNumber: z.string().optional().nullable(),
  bio: z.string().optional().nullable(),
  companyName: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  skills: z.array(z.string()).optional().nullable(),
  hourlyRate: z.number().positive().optional().nullable(),

  // Identity (Sensitive)
  idNumber: z.string().min(10).max(10).optional().nullable(),
  idExpiryDate: z.string().datetime().or(z.date()).optional().nullable(),
  nationality: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  frontId: z.string().optional().nullable().or(z.literal('')),
  backId: z.string().optional().nullable().or(z.literal('')),
  supportingDocs: z.string().optional().nullable().or(z.literal('')),

  // Banking (Sensitive)
  ibanNumber: z.string().min(24).max(24).optional().nullable(),
  bankName: z.string().optional().nullable(),
  accountHolderName: z.string().optional().nullable()
});

export type ProfileSetupDto = z.infer<typeof profileSetupSchema>;
