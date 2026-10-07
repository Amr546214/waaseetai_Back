import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';

// PUT /profiles/update/:tabName. Unknown keys are stripped (never rejected, so the current UI tabs keep working) and the service reads an explicit
// allow-list on top of this. '' is tolerated where the UI clears a field.
const optionalText = (max: number) => z.string().trim().max(max, `الحد الأقصى ${max} حرفًا`).optional();
const nullableText = (max: number) => z.string().trim().max(max, `الحد الأقصى ${max} حرفًا`).nullable().optional();
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

export const updateContactSchema = z.object({
  firstName: personName(),
  lastName: personName(),
  avatarUrl: avatarValue,
  email: z.string().trim().email('البريد الإلكتروني غير صحيح').max(254).optional(),
  phoneNumber: optionalText(20),
  alternativePhone: nullableText(20),
  address: nullableText(300),
  region: nullableText(80),
  city: nullableText(80),
  country: optionalText(60)
});

export const updateBankingSchema = z.object({
  paymentMethod: z.enum(['bank', 'wallet', 'paypal']).optional(),
  accountHolderName: optionalText(100),
  bankName: optionalText(100),
  ibanNumber: optionalText(40),
  walletProvider: optionalText(60),
  walletPhone: optionalText(20),
  walletId: optionalText(60),
  paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').nullable().optional()
});

export const profileTabSchemas = {
  basics: updateBasicsSchema,
  contact: updateContactSchema,
  identity: updateIdentitySchema,
  banking: updateBankingSchema
} as const;
