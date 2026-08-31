import { z } from 'zod';

export const createClientRequestSchema = z.object({
  specialtyId: z.string().optional(),
  specialty: z.string().optional(),
  title: z.string().min(3, 'عنوان الطلب يجب أن يكون 3 أحرف على الأقل'),
  description: z.string().min(10, 'وصف المشروع يجب أن يكون 10 أحرف على الأقل'),
  subSpecialties: z.array(z.string()).optional().default([]),
  requiredSkills: z.array(z.string()).optional().default([]),
  
  // Budget & Timeline
  budgetType: z.string().optional().default('FIXED'), // FIXED, RANGE, HOURLY or fixed, range, hourly
  minBudget: z.number().nullable().optional(),
  maxBudget: z.number().nullable().optional(),
  expectedDurationDays: z.number().nullable().optional(),
  
  // Conditions & Requirements
  preferredProviderType: z.string().optional().default('ANY'), // INDIVIDUAL, COMPANY, ACCREDITED_ONLY, ANY
  requiresNda: z.boolean().optional().default(false),
  attachments: z.array(z.string()).optional().default([]),
  outputs: z.string().max(1000).optional().default(''),
  customConditions: z.string().max(2000).optional().default(''),
  ipRights: z.enum(['client', 'shared', 'provider']).optional().default('client'),
  providerPreferences: z.object({
    level: z.string().nullable().optional(),
    minRating: z.number().min(0).max(5).nullable().optional(),
    language: z.enum(['ar', 'en', 'both']).optional(),
    location: z.enum(['sa', 'gcc', 'any', '']).nullable().optional()
  }).optional().default({}),
  allowNegotiation: z.boolean().optional().default(true),
  splitMilestones: z.boolean().optional().default(false),
  milestones: z.array(z.object({ name: z.string().min(2).max(150), pct: z.number().positive().max(100) })).optional().default([])
});

export type CreateClientRequestDto = z.infer<typeof createClientRequestSchema>;

export const clientRequestAiSuggestSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  specialtyId: z.string().optional(),
  specialtyName: z.string().optional(),
  subSpecialties: z.array(z.string()).optional().default([])
});

export type ClientRequestAiSuggestDto = z.infer<typeof clientRequestAiSuggestSchema>;
