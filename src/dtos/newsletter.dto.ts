import { z } from 'zod';

export const subscribeNewsletterSchema = z.object({
  email: z.string().trim().email('البريد الإلكتروني غير صحيح'),
  source: z.string().trim().max(100).optional(),
});

export const unsubscribeNewsletterSchema = z.object({
  email: z.string().trim().email('البريد الإلكتروني غير صحيح'),
});

export type SubscribeNewsletterInput = z.infer<typeof subscribeNewsletterSchema>;
export type UnsubscribeNewsletterInput = z.infer<typeof unsubscribeNewsletterSchema>;
