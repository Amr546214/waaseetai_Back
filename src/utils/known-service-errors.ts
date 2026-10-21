import type { Response } from 'express';
import { AppError } from './app-error';

/**
 * The refusals that services throw as `new Error('CODE')`. Each has a status, a fixed Arabic message that tells the user what happened and what to do next, and the
 * code itself (the client branches on `code`, never on the text). Anything NOT in this table is not guessed at: it is answered as an unexpected error (see error.middleware).
 */
export const KNOWN_SERVICE_ERRORS: Record<string, { status: number; message: string }> = {
	REQUEST_NOT_FOUND: { status: 404, message: 'لم يتم العثور على هذا الطلب. ربما حُذف أو لا يخص حسابك، أعد تحميل الصفحة.' },
	PROFILE_NOT_FOUND: { status: 404, message: 'لم يتم العثور على ملفك المهني. أكمل إعداد حسابك أولًا ثم أعد المحاولة.' },
	REQUEST_NOT_PENDING_OTP: { status: 409, message: 'انتهت صلاحية هذا الطلب أو أُكّد من قبل. ابدأ طلبًا جديدًا من الصفحة.' },
	REQUEST_NOT_PENDING_REVIEW: { status: 409, message: 'هذا الطلب لم يعد قيد المراجعة (قرّره مراجع آخر أو أُلغي). أعد تحميل الصفحة لترى حالته الحالية.' },
	REQUEST_ALREADY_PENDING: { status: 409, message: 'لديك طلب قيد مراجعة الإدارة بالفعل، لا حاجة لإرساله مرة أخرى. انتظر قرار الإدارة، وتظهر حالته في «طلباتي السابقة».' },
	EMAIL_ALREADY_USED: { status: 409, message: 'هذا البريد الإلكتروني مستخدم في حساب آخر. أدخل بريدًا مختلفًا.' },
	INVALID_OR_EXPIRED_OTP: { status: 400, message: 'رمز التحقق غير صحيح أو منتهي الصلاحية. تأكد من الرقم أو ابدأ الطلب من جديد للحصول على رمز جديد.' },
	OTP_EMAIL_DELIVERY_FAILED: { status: 503, message: 'تعذّر إرسال رمز التحقق إلى بريدك الآن، ولم يُنشأ الطلب. حاول مرة أخرى بعد قليل.' },
	ID_DOCUMENT_REQUIRED: { status: 400, message: 'مستند الهوية مطلوب. ارفع صورة أو ملف PDF واضحًا لهويتك ثم أرسل الطلب.' },
	PROFILE_FIELD_TOO_LONG: { status: 400, message: 'أحد الحقول أطول من الحد المسموح، اختصره ثم أعد المحاولة.' },
	INVALID_EMAIL: { status: 400, message: 'البريد الإلكتروني غير صالح.' },
	INVALID_PHONE: { status: 400, message: 'رقم الجوال غير صالح.' },
	INVALID_WHATSAPP: { status: 400, message: 'رقم واتساب غير صالح.' },
	INVALID_NAME: { status: 400, message: 'الاسم قصير أو غير صالح. أدخل اسمًا من حرفين على الأقل.' },
	INVALID_ID_NUMBER: { status: 400, message: 'رقم الهوية / الإقامة غير صالح: 10 أرقام تبدأ بـ 1 أو 2.' },
	INVALID_DOB: { status: 400, message: 'تاريخ الميلاد غير صالح.' },
	INVALID_IBAN: { status: 400, message: 'رقم الآيبان غير صالح.' },
	EMPTY_BIO: { status: 400, message: 'الوصف المهني مطلوب ولا يمكن أن يكون فارغًا.' },
	CURRENT_PASSWORD_INCORRECT: { status: 400, message: 'كلمة المرور الحالية غير صحيحة.' },
	PASSWORD_UNCHANGED: { status: 400, message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.' },
	PASSWORD_FIELDS_REQUIRED: { status: 400, message: 'أدخل كلمة المرور الحالية والجديدة.' },
	WEAK_PASSWORD: { status: 400, message: 'كلمة المرور ضعيفة: استخدم 8 أحرف على الأقل مع حرف كبير ورقم.' },
	INVALID_PENDING_PASSWORD: { status: 409, message: 'تعذّر تطبيق كلمة المرور المعلّقة. ابدأ طلب تغيير كلمة المرور من جديد.' },
	OTP_ATTEMPTS_EXCEEDED: { status: 429, message: 'تجاوزت عدد المحاولات المسموح به لهذا الرمز. ابدأ الطلب من جديد للحصول على رمز جديد.' },
};

/** Maps a thrown `new Error('CODE')` (or AppError) to its response; null when it is not a known refusal (the caller then answers it as unexpected). */
export function knownServiceError(error: unknown): { status: number; body: Record<string, unknown> } | null {
	if (error instanceof AppError) return { status: error.statusCode, body: { success: false, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.errors ? { errors: error.errors } : {}) } };
	const raw = typeof (error as { message?: unknown } | null)?.message === 'string' ? ((error as { message: string }).message) : '';
	const entry = KNOWN_SERVICE_ERRORS[raw];
	if (!entry) return null;
	const details = (error as { details?: unknown }).details;
	return { status: entry.status, body: { success: false, code: raw, message: entry.message, ...(Array.isArray(details) ? { errors: details } : {}) } };
}

/** Answers a service failure: a known refusal exactly as the contract says, anything else as an unexpected error (honest message + trace id; the raw text is only logged). */
export function respondServiceError(res: Response, error: unknown): Response {
	const known = knownServiceError(error);
	if (known) return res.status(known.status).json(known.body);
	return res.status(500).json({ success: false, message: String((error as { message?: unknown } | null)?.message ?? '') });
}
