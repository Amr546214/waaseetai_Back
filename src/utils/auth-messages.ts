// Texts shared by the unauthenticated auth endpoints. They are generic on purpose: the same words whether or not the account exists.
export const RESEND_GENERIC_MESSAGE = 'إذا كان هناك رمز بانتظار الإرسال لهذا الحساب فقد أرسلناه إلى بريدك الإلكتروني';

// Answer of POST /auth/register for every case in which no verification step is opened for the caller (the data is already in use, whether
// the account is active or still pending). It claims nothing about a code and is the same words for a new account whose code really went out.
export const REGISTER_GENERIC_MESSAGE = 'إن كان الحساب يحتاج تفعيلًا فستصلك تعليمات، وإن كان مسجلًا يمكنك تسجيل الدخول أو استعادة كلمة المرور';

// Answer of POST /auth/verify-otp when the caller identifies the account by e-mail: the same words and status for an unknown address, an
// active / blocked account, a missing, expired, wrong or locked code. It tells the legitimate user what to do without telling anyone which case it is.
export const ACTIVATION_CODE_REJECTED_MESSAGE = 'رمز التحقق غير صحيح أو منتهي. إن لم يصلك رمز فاطلب إرسال رمز جديد';
