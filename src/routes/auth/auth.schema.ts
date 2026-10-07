import { z } from 'zod';
import { AccountType } from '@prisma/client';
import { COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE, isCompanyAccountType } from '../../middlewares/company-unavailable.middleware';
import { sanitizedText } from '../../utils/sanitize-text';

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
}).refine(type => !isCompanyAccountType(type), { message: COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE });

// Emails are compared case-insensitively everywhere: trim + lower-case at the edge so one address has one spelling.
export const normalizedEmail = z.string().trim().toLowerCase().email('صيغة البريد الإلكتروني غير صحيحة');

export const registerSchema = z.object({
  body: z.object({
    accountType: PublicAccountTypeEnum,
    firstName: sanitizedText(z.string().min(2, 'الاسم الأول يجب أن يكون حرفين على الأقل')),
    lastName: sanitizedText(z.string().min(2, 'اسم العائلة يجب أن يكون حرفين على الأقل')),
    email: normalizedEmail,
    phoneCountryCode: z.string().default('+966'),
    phoneNumber: z.string().regex(/^\d+$/, 'رقم الجوال يجب أن يحتوي على أرقام فقط').min(9, 'رقم الجوال غير صحيح'),
    password: z
      .string()
      .min(8, 'كلمة المرور يجب أن لا تقل عن 8 أحرف')
      .regex(/[A-Z]/, 'كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل')
      .regex(/[0-9]/, 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل').optional(),
    googleIdToken: z.string().min(1).optional(),
    // Optional explicit affiliate selection at registration time — either a
    // manually-typed referral code/slug OR the value picked via the
    // search-autocomplete (GET /api/affiliates/search). Both are just the
    // affiliate's AffiliateProfile.referralSlug string, per the existing
    // convention established by marketer-overview.service.ts::getRefLinks()
    // — no second identifier type is introduced. When present, this takes
    // precedence over the waseet_ref_code cookie (see
    // auth.service.ts::resolveReferralAttribution() for the exact
    // precedence rule and the First-Touch tension it's flagged against).
    affiliateIdentifier: z.string().optional(),
    // Accepted aliases of affiliateIdentifier: unknown keys are stripped silently by zod, so a differently named field
    // would otherwise lose the referral without any error. They are folded into affiliateIdentifier below.
    referralSlug: z.string().optional(),
    referralCode: z.string().optional(),
    agreedToTerms: z.literal(true, {
      message: 'يجب الموافقة على الشروط والأحكام'
    })
  }).refine(data => !!data.password || !!data.googleIdToken, {
    message: 'كلمة المرور مطلوبة', path: ['password']
  }).transform(({ referralSlug, referralCode, ...rest }) => ({
    ...rest,
    affiliateIdentifier: rest.affiliateIdentifier ?? referralSlug ?? referralCode
  }))
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

// Login-time EMAIL OTP (purpose LOGIN_EMAIL; distinct from verifyOtpSchema/resendOtpSchema above, which activate a PENDING_VERIFICATION
// account). These verify/resend an already-ACTIVE user's mandatory login code instead. Phone/SMS is never used for login.
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
    email: normalizedEmail,
    password: z.string().min(1, 'كلمة المرور مطلوبة')
  })
});

export type LoginInput = z.infer<typeof loginSchema>['body'];

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: normalizedEmail
  })
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];

export const verifyResetCodeSchema = z.object({
  body: z.object({
    email: normalizedEmail,
    code: z.string().regex(/^\d{6}$/, 'رمز التحقق يجب أن يكون 6 أرقام')
  })
});

export type VerifyResetCodeInput = z.infer<typeof verifyResetCodeSchema>['body'];

export const resetPasswordSchema = z.object({
  body: z.object({
    email: normalizedEmail,
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
    accountType: PublicAccountTypeEnum.optional(),
    // Same optional explicit affiliate selection as registerSchema above —
    // see that field's comment for the full precedence rule. Note: actual
    // account creation for a Google sign-up happens via POST /register
    // (with googleIdToken set), not via this endpoint's 'register' intent
    // (which only verifies identity and returns googleProfile) — this field
    // is threaded through here defensively for symmetry/future use.
    affiliateIdentifier: z.string().optional()
  })
});

export type GoogleAuthInput = z.infer<typeof googleAuthSchema>['body'];
