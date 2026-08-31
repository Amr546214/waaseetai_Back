import { z } from 'zod';
import { AccountType } from '@prisma/client';

export const registerSchema = z.object({
  body: z.object({
    accountType: z.nativeEnum(AccountType, {
      message: 'نوع الحساب غير صالح'
    }),
    firstName: z.string().min(2, 'الاسم الأول يجب أن يكون حرفين على الأقل'),
    lastName: z.string().min(2, 'اسم العائلة يجب أن يكون حرفين على الأقل'),
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة'),
    phoneCountryCode: z.string().default('+966'),
    phoneNumber: z.string().regex(/^\d+$/, 'رقم الجوال يجب أن يحتوي على أرقام فقط').min(9, 'رقم الجوال غير صحيح'),
    password: z
      .string()
      .min(8, 'كلمة المرور يجب أن لا تقل عن 8 أحرف')
      .regex(/[A-Z]/, 'كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل')
      .regex(/[0-9]/, 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل'),
    agreedToTerms: z.literal(true, {
      message: 'يجب الموافقة على الشروط والأحكام'
    })
  })
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];

export const verifyOtpSchema = z.object({
  body: z.object({
    userId: z.string().uuid('معرف المستخدم غير صالح'),
    code: z.string().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام')
  })
});

export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>['body'];

export const resendOtpSchema = z.object({
  body: z.object({
    userId: z.string().uuid('معرف المستخدم غير صالح')
  })
});

export type ResendOtpInput = z.infer<typeof resendOtpSchema>['body'];

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة'),
    password: z.string().min(1, 'كلمة المرور مطلوبة')
  })
});

export type LoginInput = z.infer<typeof loginSchema>['body'];

export const googleAuthSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'Token is required'),
    accountType: z.nativeEnum(AccountType).optional()
  })
});

export type GoogleAuthInput = z.infer<typeof googleAuthSchema>['body'];
