import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error';
import { ROLE_MISMATCH_CODE } from '../utils/role-mismatch';
import { randomBytes } from 'node:crypto';
import { logger } from '../config/logger';
import { AI_FEATURE_UNAVAILABLE_CODE } from '../services/ai/ai-feature-unavailable';
import { SELF_DEALING_CODES } from '../utils/self-dealing';
import { OTP_LOCKED_MESSAGE } from '../utils/otp-purpose';
import { PAYPAL_EMAIL_FROZEN_CODE, PAYPAL_OTP_EMAIL_FAILED_CODE, OTP_THROTTLED_CODE } from '../utils/paypal-email-messages';

/** What a client is told when something unexpected failed on our side: honest (the result is unknown), with a next step and a trace id that is also in our log. Never the raw error. */
export const UNEXPECTED_ERROR_MESSAGE = 'تعذّر إكمال العملية بسبب خطأ غير متوقع من جهتنا. لا نستطيع تأكيد أن التغيير قد حُفظ، فتحقّق من الصفحة قبل تكرار العملية، وإن استمرت المشكلة تواصل مع الدعم وأرفق معرّف التتبع.';
export const UNEXPECTED_ERROR_CODE = 'INTERNAL_ERROR';
export const newTraceId = (): string => randomBytes(4).toString('hex').toUpperCase();
const APP_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const ARABIC_TEXT = /[\u0600-\u06FF]/;
/** Text that must never reach a user even inside an Arabic sentence: library / database / stack / path fragments. */
const LEAKY = /prisma|invocation|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bFROM\b|constraint|relation "|ECONN|ETIMEDOUT|ENOTFOUND|\bat \S+ \(|\.(?:ts|js):\d+|node_modules|private:|secret|password/i;

// Known library errors that are the caller's mistake (4xx), not a server fault: they must never surface as a 500 "Internal Server Error".
// Messages are fixed Arabic text — nothing from the library error (field names, constraint targets, SQL) is echoed.
function mapKnownError(err: unknown): { statusCode: number; message: string } | null {
  const e = err as { code?: unknown; type?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; field?: unknown } | null;
  if (!e || typeof e !== 'object' || err instanceof AppError) return null;

  // Prisma known request errors
  if (e.code === 'P2002') return { statusCode: 409, message: 'هذه القيمة مستخدمة مسبقًا، يرجى اختيار قيمة أخرى' };
  if (e.code === 'P2025') return { statusCode: 404, message: 'العنصر المطلوب غير موجود' };

  // express.json(): malformed body / body too large / unsupported charset or encoding
  if (e.type === 'entity.parse.failed') return { statusCode: 400, message: 'صيغة الطلب غير صحيحة (JSON غير صالح)' };
  if (e.type === 'entity.too.large') return { statusCode: 413, message: 'حجم الطلب كبير جدًا' };
  if (e.type === 'charset.unsupported' || e.type === 'encoding.unsupported') return { statusCode: 415, message: 'ترميز الطلب غير مدعوم' };

  // multer
  if (e.name === 'MulterError') {
    if (e.code === 'LIMIT_FILE_SIZE') return { statusCode: 413, message: 'حجم الملف أكبر من الحد المسموح' };
    if (e.code === 'LIMIT_FILE_COUNT' || e.code === 'LIMIT_UNEXPECTED_FILE') return { statusCode: 400, message: 'عدد الملفات أو اسم الحقل غير صحيح' };
    return { statusCode: 400, message: 'تعذر معالجة الملف المرفوع' };
  }
  return null;
}

export const globalErrorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let errors: any[] | undefined = undefined;
  let code: string | undefined = undefined;
  let extra: Record<string, unknown> | undefined = undefined;
  let traceId: string | undefined = undefined;

  const mapped = mapKnownError(err);
  if (mapped) {
    statusCode = mapped.statusCode;
    message = mapped.message;
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    errors = err.errors;
    // Only the fixed, hardcoded AI-disabled marker is forwarded.
    if ((err as { code?: unknown }).code === AI_FEATURE_UNAVAILABLE_CODE) code = AI_FEATURE_UNAVAILABLE_CODE;
    // The PayPal-email freeze also says when it ends (two fixed, non-sensitive fields).
    if ((err as { code?: unknown }).code === PAYPAL_EMAIL_FROZEN_CODE) {
      code = PAYPAL_EMAIL_FROZEN_CODE;
      const e = err as unknown as { availableAt?: string; retryAfterSeconds?: number };
      extra = { availableAt: e.availableAt, retryAfterSeconds: e.retryAfterSeconds };
    }
    // A throttled OTP request says how long to wait; a failed OTP e-mail has its own fixed code.
    if ((err as { code?: unknown }).code === OTP_THROTTLED_CODE) {
      code = OTP_THROTTLED_CODE;
      extra = { retryAfterSeconds: (err as unknown as { retryAfterSeconds?: number }).retryAfterSeconds };
    }
    if ((err as { code?: unknown }).code === PAYPAL_OTP_EMAIL_FAILED_CODE) code = PAYPAL_OTP_EMAIL_FAILED_CODE;
    // Fixed self-purchase / self-negotiation / self-hire markers (a stable code the FE branches on).
    const appCode = (err as { code?: unknown }).code;
    if (typeof appCode === 'string' && SELF_DEALING_CODES.has(appCode)) code = appCode;
    // A wrong-role refusal (the caller's OWN roles only): which role the page needs, the role in use and whether switching is possible.
    if ((err as { code?: unknown }).code === ROLE_MISMATCH_CODE) {
      code = ROLE_MISMATCH_CODE;
      const e = err as unknown as { requiredRoles?: string[]; activeRole?: string | null; canSwitch?: boolean };
      extra = { requiredRoles: e.requiredRoles, activeRole: e.activeRole, canSwitch: e.canSwitch };
    }
  } else {
    // Unhandled operational/programming errors: the full error goes to OUR log with a trace id; the client gets the honest fixed message and that id.
    traceId = newTraceId();
    logger.error(`Unhandled Exception: [trace ${traceId}]`, err);
    message = UNEXPECTED_ERROR_MESSAGE;
    code = UNEXPECTED_ERROR_CODE;
    if (process.env.NODE_ENV === 'development') {
      message = err.message;
      errors = [err.stack];
    }
  }
  // A plain AppError may carry its own fixed marker (never user input); the specific markers above keep their dedicated fields.
  const ownCode = (err as { code?: unknown }).code;
  if (!code && typeof ownCode === 'string' && APP_CODE.test(ownCode)) code = ownCode;
  // An operational 5xx without its own Arabic explanation (a bare "Internal Server Error", a library text) is replaced the same way as an unexpected one.
  if (statusCode >= 500 && !traceId && !(typeof message === 'string' && ARABIC_TEXT.test(message) && !LEAKY.test(message))) {
    traceId = newTraceId();
    logger.error(`Operational 5xx replaced by the safe message [trace ${traceId}]: ${message}`);
    message = UNEXPECTED_ERROR_MESSAGE;
    code = code ?? UNEXPECTED_ERROR_CODE;
    errors = undefined;
  }
  if (statusCode >= 500 && !traceId) traceId = newTraceId();

  // A wait (429) or lock (423) always says how long, in machine-readable form: Retry-After header + retryAfterSeconds + retryAt (additive).
  // The duration comes from the error itself (retryAfterSeconds / errors[].retryAfterSeconds) or the header a limiter already set; never invented.
  if (statusCode === 429 || statusCode === 423) {
    const fromErr = (err as unknown as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    const fromList = (errors ?? []).map((x: any) => x?.retryAfterSeconds).find((n: unknown) => typeof n === 'number');
    const fromHeader = Number(res.getHeader?.('Retry-After'));
    const raw = [fromErr, fromList, fromHeader].find((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    if (raw !== undefined) {
      const seconds = Math.ceil(raw);
      if (!res.getHeader?.('Retry-After')) res.setHeader?.('Retry-After', String(seconds));
      extra = { ...(extra ?? {}), retryAfterSeconds: seconds, retryAt: new Date(Date.now() + seconds * 1000).toISOString() };
    }
  }
  // Locked by wrong attempts: a stable code; there is no timer (a new code is requested instead), so none is invented.
  if (statusCode === 429 && message === OTP_LOCKED_MESSAGE && !code) code = 'OTP_ATTEMPTS_LOCKED';

  // Log all non-4xx errors
  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.url} >> StatusCode:: ${statusCode}, Message:: ${message}${traceId ? ` [trace ${traceId}]` : ''}`);
  } else {
    logger.warn(`[${req.method}] ${req.url} >> StatusCode:: ${statusCode}, Message:: ${message}`);
  }

  if (res.locals) res.locals.errorContractApplied = true;
  res.status(statusCode).json({
    success: false,
    message,
    ...(code && { code }),
    ...(traceId && { traceId }),
    ...(extra && extra),
    ...(errors && { errors })
  });
};
