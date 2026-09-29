import { z } from 'zod';
import { AccountType } from '@prisma/client';

// The only account types a public, unauthenticated signup request (email/
// password registration or a brand-new Google sign-up) may ever request.
// ADMIN, SUPER_ADMIN and EMPLOYEE are internal/operator account types
// provisioned out-of-band and must never be reachable from a public request
// body — both registerSchema and googleAuthSchema validate against this
// restricted enum instead of the full Prisma AccountType.
export const PublicAccountTypeEnum = z.enum([
  AccountType.CLIENT_INDIVIDUAL,
  AccountType.CLIENT_COMPANY,
  AccountType.PROVIDER_INDIVIDUAL,
  AccountType.PROVIDER_COMPANY,
  AccountType.MARKETING_BROKER
], {
  message: 'نوع الحساب غير صالح'
});

export const registerSchema = z.object({
  body: z.object({
    accountType: PublicAccountTypeEnum,
    firstName: z.string().min(2, 'الاسم الأول يجب أن يكون حرفين على الأقل'),
    lastName: z.string().min(2, 'اسم العائلة يجب أن يكون حرفين على الأقل'),
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة'),
    phoneCountryCode: z.string().default('+966'),
    phoneNumber: z.string().regex(/^\d+$/, 'رقم الجوال يجب أن يحتوي على أرقام فقط').min(9, 'رقم الجوال غير صحيح'),
    password: z
      .string()
      .min(8, 'كلمة المرور يجب أن لا تقل عن 8 أحرف')
      .regex(/[A-Z]/, 'كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل')
      .regex(/[0-9]/, 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل').optional(),
    googleIdToken: z.string().min(1).optional(),
    agreedToTerms: z.literal(true, {
      message: 'يجب الموافقة على الشروط والأحكام'
    })
  }).refine(data => !!data.password || !!data.googleIdToken, {
    message: 'كلمة المرور مطلوبة', path: ['password']
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

// Login-time phone OTP (distinct from verifyOtpSchema/resendOtpSchema above,
// which activate a PENDING_VERIFICATION account's email OTP). These verify/
// resend an already-ACTIVE user's mandatory phone OTP challenge instead.
export const verifyLoginOtpSchema = z.object({
  body: z.object({
    userId: z.string().uuid('معرف المستخدم غير صالح'),
    code: z.string().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام')
  })
});

export type VerifyLoginOtpInput = z.infer<typeof verifyLoginOtpSchema>['body'];

export const resendLoginOtpSchema = z.object({
  body: z.object({
    userId: z.string().uuid('معرف المستخدم غير صالح')
  })
});

export type ResendLoginOtpInput = z.infer<typeof resendLoginOtpSchema>['body'];

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة'),
    password: z.string().min(1, 'كلمة المرور مطلوبة')
  })
});

export type LoginInput = z.infer<typeof loginSchema>['body'];

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة')
  })
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];

export const verifyResetCodeSchema = z.object({
  body: z.object({
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة'),
    code: z.string().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام')
  })
});

export type VerifyResetCodeInput = z.infer<typeof verifyResetCodeSchema>['body'];

export const resetPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('صيغة البريد الإلكتروني غير صحيحة'),
    code: z.string().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام'),
    newPassword: z
      .string()
      .min(8, 'كلمة المرور يجب أن لا تقل عن 8 أحرف')
      .regex(/[A-Z]/, 'كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل')
      .regex(/[0-9]/, 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل')
  })
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>['body'];

export const googleAuthSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'Token is required'),
    intent: z.enum(['login', 'register']).optional(),
    accountType: PublicAccountTypeEnum.optional()
  })
});

export type GoogleAuthInput = z.infer<typeof googleAuthSchema>['body'];
