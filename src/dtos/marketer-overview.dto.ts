import { z } from 'zod';

// Per-channel tracking link: a display name and the utm_source tag appended to the marketer's own referral link. It is
// only a label; it never creates a referral code and never has any financial effect (attribution always resolves the
// marketer's own referralSlug). `customSlug` is therefore not accepted.
export const createCustomLinkSchema = z.object({
  channelName: z.string().trim().min(1, 'اسم القناة مطلوب').max(60, 'اسم القناة طويل جداً'),
  utmSource: z
    .string()
    .trim()
    .min(1, 'رمز المصدر مطلوب')
    .max(40, 'رمز المصدر طويل جداً')
    .regex(/^[A-Za-z0-9_-]+$/, 'رمز المصدر يقبل حروفاً إنجليزية وأرقاماً وشرطات فقط')
    .transform((v) => v.toLowerCase()),
}).strict();

export const updateRefSettingsSchema = z.object({
  notifyOnNewReferral: z.boolean().optional(),
  sharePerformanceStats: z.boolean().optional(),
}).strict();

export type CreateCustomLinkInput = z.infer<typeof createCustomLinkSchema>;
