import { z } from 'zod';

export const updateBasicsSchema = z.object({
  firstName: z.string().min(2, 'الاسم الأول يجب أن يكون حرفين على الأقل').optional(),
  lastName: z.string().min(2, 'الاسم الأخير يجب أن يكون حرفين على الأقل').optional(),
  email: z.string().email('البريد الإلكتروني غير صحيح').optional(),
  phoneNumber: z.string().optional()
});

export const updateIdentitySchema = z.object({
  idNumber: z.string().optional(),
  idExpiryDate: z.string().optional(),
  nationality: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional()
});

export const updateContactSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صحيح').optional(),
  phoneNumber: z.string().optional(),
  alternativePhone: z.string().optional(),
  address: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional()
});

export const updateBankingSchema = z.object({
  paymentMethod: z.enum(['bank', 'wallet']).optional(),
  accountHolderName: z.string().optional(),
  bankName: z.string().optional(),
  ibanNumber: z.string().optional(),
  walletProvider: z.string().optional(),
  walletPhone: z.string().optional(),
  walletId: z.string().optional()
});
