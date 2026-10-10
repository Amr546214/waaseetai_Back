export const PAYPAL_EMAIL_OTP_REQUIRED_MESSAGE = 'تغيير بريد PayPal يتطلب رمز تحقق يُرسل إلى بريد حسابك';
export const PAYPAL_EMAIL_FROZEN_MESSAGE = 'تم تغيير بريد PayPal مؤخرًا. يمكنك طلب السحب بعد مرور 24 ساعة.';
export const PAYPAL_EMAIL_FROZEN_CODE = 'PAYPAL_EMAIL_FROZEN';
export const PAYPAL_OTP_EMAIL_FAILED_MESSAGE = 'تعذر إرسال رمز التحقق، حاول مرة أخرى';
export const PAYPAL_OTP_EMAIL_FAILED_CODE = 'PAYPAL_OTP_EMAIL_FAILED';
export const OTP_THROTTLED_CODE = 'OTP_THROTTLED';

/** The withdrawal refused because the PayPal email was changed in the last 24 hours: a clear business error that says WHEN it ends. */
export function paypalEmailFrozenError(AppErrorCtor: new (message: string, status: number) => Error, frozenUntil: Date, now: Date = new Date()) {
  const retryAfterSeconds = Math.max(1, Math.ceil((frozenUntil.getTime() - now.getTime()) / 1000));
  return Object.assign(new AppErrorCtor(PAYPAL_EMAIL_FROZEN_MESSAGE, 400), { code: PAYPAL_EMAIL_FROZEN_CODE, availableAt: frozenUntil.toISOString(), retryAfterSeconds });
}
