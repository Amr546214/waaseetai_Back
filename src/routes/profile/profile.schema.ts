import { z } from 'zod';export const updateClientProfileSchema = z.object({
  body: z.object({
    companyName: z.string().optional(),
    companySize: z.string().optional(),
    industry: z.string().optional(),
    website: z.string().url('رابط الموقع غير صحيح').optional().or(z.literal('')),
    bio: z.string().max(1000, 'النبذة يجب أن لا تتجاوز 1000 حرف').optional()
  })
});

export const updateProviderProfileSchema = z.object({
  body: z.object({
    companyName: z.string().optional(),
    bio: z.string().max(1000, 'النبذة يجب أن لا تتجاوز 1000 حرف').optional(),
    skills: z.array(z.string()).optional(),
    hourlyRate: z.number().positive('سعر الساعة يجب أن يكون رقماً موجباً').optional(),
    yearsOfExperience: z.number().positive().optional(),
    headline: z.string().optional(),
    location: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    githubUrl: z.string().url('الرابط غير صحيح').optional().or(z.literal('')),
    linkedinUrl: z.string().url('الرابط غير صحيح').optional().or(z.literal('')),
    websiteUrl: z.string().url('الرابط غير صحيح').optional().or(z.literal(''))
  })
});

export type UpdateClientProfileInput = z.infer<typeof updateClientProfileSchema>['body'];
export type UpdateProviderProfileInput = z.infer<typeof updateProviderProfileSchema>['body'];
