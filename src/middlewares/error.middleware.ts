import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { AI_FEATURE_UNAVAILABLE_CODE } from '../services/ai/ai-feature-unavailable';

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
  } else {
    // Unhandled operational/programming errors
    logger.error('Unhandled Exception:', err);
    if (process.env.NODE_ENV === 'development') {
      message = err.message;
      errors = [err.stack];
    }
  }

  // Log all non-4xx errors
  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.url} >> StatusCode:: ${statusCode}, Message:: ${message}`);
  } else {
    logger.warn(`[${req.method}] ${req.url} >> StatusCode:: ${statusCode}, Message:: ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(code && { code }),
    ...(errors && { errors })
  });
};
