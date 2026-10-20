import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';
import { nonPaypalPayoutKeys, PAYPAL_ONLY_MESSAGE } from '../utils/client-payout-fields';
import { AFFILIATE_BIO_MAX_LENGTH } from '../utils/completion-calculators';
import { isBlankText } from '../utils/sanitize-text';
import { marketingChannelProblem } from '../utils/marketing-channel-validation';

/**
 * PATCH /marketer/profile/paypal (and the old /bank-info path): the PayPal email is the ONLY payout destination. Any bank / IBAN / account
 * holder / wallet / swift value in the payload is a 400 and nothing is stored. An empty email removes the saved one.
 */
export const updatePaypalPayoutSchema = z.object({
  paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').email('أدخل بريد PayPal صالحًا مثل name@example.com').nullable().optional().or(z.literal('')),
}).catchall(z.unknown()).superRefine((data, ctx) => {
  for (const key of nonPaypalPayoutKeys(data)) ctx.addIssue({ code: 'custom', path: [key], message: PAYPAL_ONLY_MESSAGE });
});

export type UpdatePaypalPayoutInput = z.infer<typeof updatePaypalPayoutSchema>;

/**
 * PATCH /marketer/profile/marketing-info. The bio is optional and may be empty for ordinary updates (an avatar-only update leaves it alone; it only counts toward completion
 * from 50 characters). The setup wizard sends `setup: true`: then the bio is REQUIRED (not blank after sanitizing / trimming). `setup` is never stored.
 */
export const updateMarketingInfoSchema = z.object({
  avatarUrl: z.string().optional().nullable(),
  bio: sanitizedText(z.string().max(AFFILIATE_BIO_MAX_LENGTH, `الوصف التسويقي يجب ألا يتجاوز ${AFFILIATE_BIO_MAX_LENGTH} حرف`)).optional().nullable(),
  setup: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.setup === true && isBlankText(data.bio)) ctx.addIssue({ code: 'custom', path: ['bio'], message: 'الوصف التسويقي مطلوب' });
});

/** The channel platforms the marketer pages offer. */
export const MARKETING_PLATFORMS = ['LINKEDIN', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'TWITTER', 'INSTAGRAM'] as const;

/**
 * POST /marketer/profile/channels: a known platform and a non-empty handle. The setup wizard sends `setup: true`: then the channel must also be VALID for its platform
 * (no spaces, a link on the platform's own domain or a well-formed handle / WhatsApp number). Ordinary callers keep the lenient rule. `setup` is never stored.
 */
export const addChannelSchema = z.object({
  platform: z.string({ message: 'نوع القناة مطلوب' }).trim().toUpperCase().pipe(
    z.enum(MARKETING_PLATFORMS, { message: 'نوع القناة غير معروف' })
  ),
  handle: sanitizedText(z.string({ message: 'معرّف القناة مطلوب' }).trim().min(1, 'معرّف القناة مطلوب').max(200, 'معرّف القناة طويل جدًا')),
  url: sanitizedText(z.string().trim().max(500, 'الرابط طويل جدًا')).optional().nullable(),
  setup: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.setup !== true) return;
  const problem = marketingChannelProblem(data.platform, data.handle);
  if (problem) ctx.addIssue({ code: 'custom', path: ['handle'], message: problem });
  if (data.url) {
    try { if (!['http:', 'https:'].includes(new URL(data.url).protocol)) throw new Error(); }
    catch { ctx.addIssue({ code: 'custom', path: ['url'], message: 'الرابط يجب أن يبدأ بـ http أو https' }); }
  }
});

export type UpdateMarketingInfoInput = z.infer<typeof updateMarketingInfoSchema>;
export type AddChannelInput = z.infer<typeof addChannelSchema>;
