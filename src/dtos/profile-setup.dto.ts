import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';

export const profileSetupSchema = z.object({
  // Preferences / Basic Info
  // null = not provided; the avatar is a Cloudinary URL or an image data URI (re-stored by the service)
  avatarUrl: z.string().max(12_000_000).optional().nullable().transform(v => v ?? undefined),
  phoneNumber: z.string().trim().transform(v => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{9,15}$/, 'رقم الجوال غير صحيح')).or(z.literal('').transform(() => undefined)).optional().nullable().transform(v => v ?? undefined),
  bio: sanitizedText(z.string().max(1000, 'النبذة يجب أن لا تتجاوز 1000 حرف')).optional().nullable(),
  companyName: sanitizedText(z.string().trim().max(120)).optional().nullable(),
  industry: sanitizedText(z.string().trim().max(100)).optional().nullable(),
  skills: z.array(z.string().trim().min(1).max(80)).max(50).optional().nullable(),
  hourlyRate: z.number().positive().optional().nullable(),

  // Identity (Sensitive)
  idNumber: z.string().trim().regex(/^[12]\d{9}$/, 'رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2').optional().nullable(),
  idExpiryDate: z.string().datetime().or(z.date()).optional().nullable(),
  nationality: sanitizedText(z.string().trim().max(60)).optional().nullable(),
  city: sanitizedText(z.string().trim().max(80)).optional().nullable(),
  country: sanitizedText(z.string().trim().max(60)).optional().nullable(),
  // KYC files: base64 data URI or an already stored reference; type/size are checked by assertKycFileValues before anything is stored.
  frontId: z.string().max(15_000_000).optional().nullable().or(z.literal('')),
  backId: z.string().max(15_000_000).optional().nullable().or(z.literal('')),
  supportingDocs: z.string().max(15_000_000).optional().nullable().or(z.literal('')),

  // Banking (Sensitive)
  ibanNumber: z.string().min(24).max(24).optional().nullable(),
  bankName: sanitizedText(z.string().trim().max(100)).optional().nullable(),
  accountHolderName: sanitizedText(z.string().trim().max(100)).optional().nullable()
});

export type ProfileSetupDto = z.infer<typeof profileSetupSchema>;
