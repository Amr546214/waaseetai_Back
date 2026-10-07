// Every OTP row carries `context.purpose`, and every verification path accepts ONLY its own purpose. A code issued for one purpose can
// therefore never be used for another (AUD-FND-000031). Rows without a purpose (issued before this rule) are rejected everywhere.
//
// Values already stored by existing flows are kept as they are so in-flight codes keep working:
//  - PASSWORD_RESET            (forgot-password / reset)
//  - checkout_payment          (wallet checkout confirmation)
//  - CLIENT_CONTRACT_SIGNATURE (contract signing / escrow deposit)
// New: ACTIVATION (account activation email) and SENSITIVE_CHANGE (provider sensitive profile change).
// PHONE codes (OtpType.PHONE) are not used by any live flow (SMS verification is disabled); PHONE_VERIFY is reserved for it.
export const OtpPurpose = {
  ACTIVATION: 'ACTIVATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  SENSITIVE_CHANGE: 'SENSITIVE_CHANGE',
  CHECKOUT_PAYMENT: 'checkout_payment',
  CLIENT_CONTRACT_SIGNATURE: 'CLIENT_CONTRACT_SIGNATURE',
  PHONE_VERIFY: 'PHONE_VERIFY',
  // PUT-less phone change (AUD-FND-000026): the new number travels in context.newPhone; the code goes to the ACCOUNT EMAIL (SMS is disabled).
  PHONE_CHANGE: 'PHONE_CHANGE',
  // Mandatory second step of every password login (owner decision #4): the code goes to the ACCOUNT EMAIL, never by SMS.
  LOGIN_EMAIL: 'LOGIN_EMAIL',
} as const;
export type OtpPurposeValue = (typeof OtpPurpose)[keyof typeof OtpPurpose];

/** Wrong guesses allowed per code before it is deleted and a new one must be requested (AUD-FND-000030). */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LOCKED_MESSAGE = 'تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد';
