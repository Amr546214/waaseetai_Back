import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';
import { isValidIban } from '../utils/iban.util';
import { AFFILIATE_BIO_MAX_LENGTH } from '../utils/completion-calculators';

export const updateBankInfoSchema = z.object({
  bankName: z.string().trim().max(120).optional(),
  accountHolderName: z.string().trim().max(120).optional(),
  iban: z.string().trim().max(34).optional().refine(
    (value) => !value || isValidIban(value),
    { message: 'رقم IBAN غير صحيح' }
  ),
  swiftCode: z.string().trim().max(11).optional(),
});

export type UpdateBankInfoInput = z.infer<typeof updateBankInfoSchema>;

/** PATCH /marketer/profile/marketing-info. The bio is optional and may be empty (it only counts toward completion from 50 characters). */
export const updateMarketingInfoSchema = z.object({
  avatarUrl: z.string().optional().nullable(),
  bio: sanitizedText(z.string().max(AFFILIATE_BIO_MAX_LENGTH, `الوصف التسويقي يجب ألا يتجاوز ${AFFILIATE_BIO_MAX_LENGTH} حرف`)).optional().nullable(),
});

/** The channel platforms the marketer pages offer. */
export const MARKETING_PLATFORMS = ['LINKEDIN', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'TWITTER', 'INSTAGRAM'] as const;

/** POST /marketer/profile/channels: a known platform and a non-empty handle. */
export const addChannelSchema = z.object({
  platform: z.string({ message: 'نوع القناة مطلوب' }).trim().toUpperCase().pipe(
    z.enum(MARKETING_PLATFORMS, { message: 'نوع القناة غير معروف' })
  ),
  handle: sanitizedText(z.string({ message: 'معرّف القناة مطلوب' }).trim().min(1, 'معرّف القناة مطلوب').max(200, 'معرّف القناة طويل جدًا')),
  url: sanitizedText(z.string().trim().max(500, 'الرابط طويل جدًا')).optional().nullable(),
});

export type UpdateMarketingInfoInput = z.infer<typeof updateMarketingInfoSchema>;
export type AddChannelInput = z.infer<typeof addChannelSchema>;
