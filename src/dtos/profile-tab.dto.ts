import { z } from 'zod';
import { nonPaypalPayoutKeys, PAYPAL_ONLY_MESSAGE } from '../utils/client-payout-fields';
import { sanitizedText } from '../utils/sanitize-text';

// PUT /profiles/update/:tabName. Unknown keys are stripped (never rejected, so the current UI tabs keep working) and the service reads an explicit
// allow-list on top of this. '' is tolerated where the UI clears a field.
// free text: markup is stripped (sanitizedText) before the length check
const optionalText = (max: number) => sanitizedText(z.string().trim().max(max, `الحد الأقصى ${max} حرفًا`)).optional();
const nullableText = (max: number) => sanitizedText(z.string().trim().max(max, `الحد الأقصى ${max} حرفًا`)).nullable().optional();
const personName = () => sanitizedText(z.string().trim().min(2, 'الاسم يجب أن يكون حرفين على الأقل').max(50, 'الاسم يجب ألا يتجاوز 50 حرفًا')).optional();
// avatarUrl: null = not provided (never erases); '' = explicit delete; otherwise, a Cloudinary URL, or an image data URI that the service re-stores; the upload guards cap its real size.
const avatarValue = z.string().max(12_000_000, 'الصورة كبيرة جدًا').nullable().optional().transform(v => v ?? undefined);

export const updateBasicsSchema = z.object({
  firstName: personName(),
  lastName: personName(),
  avatarUrl: avatarValue,
  email: z.string().trim().email('البريد الإلكتروني غير صحيح').max(254).optional(),
  phoneNumber: optionalText(20)
});

export const updateIdentitySchema = z.object({
  idNumber: optionalText(32),
  idExpiryDate: optionalText(32),
  nationality: optionalText(60),
  country: optionalText(60),
  city: optionalText(80)
});

// WhatsApp / alternative phone: ONE string (E.164 from the client). The phone-input component's object {countryCode, dialCode, number, e164Number} is the
// known client mistake (400 "expected string, received object" in English); a cached old bundle may still send it, so an object whose e164Number is a
// well-formed E.164 string is read as that string. Any other non-string is a field-level 400 in Arabic.
const E164 = /^\+\d{8,15}$/;
const alternativePhone = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { e164Number?: unknown }).e164Number === 'string' && E164.test((v as { e164Number: string }).e164Number) ? (v as { e164Number: string }).e164Number : v),
  sanitizedText(z.string({ error: 'رقم WhatsApp غير صالح' }).trim().max(20, 'رقم WhatsApp طويل جدًا')).nullable().optional()
);

export const updateContactSchema = z.object({
  firstName: personName(),
  lastName: personName(),
  avatarUrl: avatarValue,
  email: z.string().trim().email('البريد الإلكتروني غير صحيح').max(254).optional(),
  phoneNumber: optionalText(20),
  alternativePhone,
  address: nullableText(300),
  region: nullableText(80),
  city: nullableText(80),
  country: optionalText(60)
});

// PayPal is the only financial method on the platform: any bank / IBAN / account holder / wallet value in this payload is a 400 (never stored).
export const updateBankingSchema = z.object({
  paymentMethod: z.enum(['paypal', 'wallet']).optional(), // 'wallet' = the legacy name of the PayPal option in old clients
  paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').nullable().optional()
}).catchall(z.unknown()).superRefine((data, ctx) => {
  for (const key of nonPaypalPayoutKeys(data)) ctx.addIssue({ code: 'custom', path: [key], message: PAYPAL_ONLY_MESSAGE });
});

export const profileTabSchemas = {
  basics: updateBasicsSchema,
  contact: updateContactSchema,
  identity: updateIdentitySchema,
  banking: updateBankingSchema
} as const;
