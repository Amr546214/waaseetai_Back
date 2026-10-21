import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';
import { UNEXPECTED_ERROR_CODE, UNEXPECTED_ERROR_MESSAGE, newTraceId } from './error.middleware';

const ARABIC_TEXT = /[؀-ۿ]/;
const LEAKY = /prisma|invocation|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bFROM\b|constraint|relation "|ECONN|ETIMEDOUT|ENOTFOUND|\bat \S+ \(|\.(?:ts|js):\d+|node_modules|private:|secret|password/i;

/**
 * Many controllers answer a failure themselves (`res.status(500).json({ message: error.message })`) instead of passing it to the global error handler, which would put a
 * raw library / database text in front of the user. This is the safety net for every one of them (and for future ones): a 5xx JSON body that did not come from the
 * error handler keeps its message only when it is a deliberate Arabic explanation without library / SQL / path fragments; otherwise it becomes the honest fixed message with a
 * fixed code and a trace id that is also in our log. 4xx bodies are never touched (they are the business answers the client branches on).
 */
/** 401 / 403 / 404 answers that carry a plain ENGLISH sentence (e.g. «Unauthorized», «Provider not found»): the same fixed Arabic text per status + a fixed code. Raw UPPER_SNAKE codes and Arabic texts are left alone (the client maps / shows those). */
const ENGLISH_SENTENCE = /^[A-Za-z][A-Za-z0-9 ,.'’:;!?()\-\/_`"]*$/;
const CLIENT_ERROR_DEFAULTS: Record<number, { message: string; code: string }> = {
	401: { message: 'انتهت جلستك أو لم تسجّل الدخول. سجّل الدخول ثم أعد المحاولة.', code: 'SESSION_REQUIRED' },
	403: { message: 'ليست لديك صلاحية لتنفيذ هذا الإجراء بهذا الحساب. تأكد من أنك تستخدم الحساب والدور المناسبين، أو تواصل مع الدعم.', code: 'FORBIDDEN' },
	404: { message: 'العنصر المطلوب غير موجود. ربما حُذف أو تغيّر رابطه، أعد تحميل الصفحة أو ارجع إلى القائمة.', code: 'NOT_FOUND' },
};
const isRawCode = (m: string) => /^[A-Z][A-Z0-9_]*(:.*)?$/.test(m);

export function safeServerErrors(_req: Request, res: Response, next: NextFunction) {
	const originalJson = res.json.bind(res);
	res.json = ((body?: unknown) => {
		if (CLIENT_ERROR_DEFAULTS[res.statusCode] && !res.locals.errorContractApplied && body && typeof body === 'object' && !Array.isArray(body)) {
			const b = body as Record<string, unknown>;
			const m = typeof b.message === 'string' ? b.message.trim() : '';
			if (m && !isRawCode(m) && ENGLISH_SENTENCE.test(m) && !/[\u0600-\u06FF]/.test(m)) body = { ...b, ...CLIENT_ERROR_DEFAULTS[res.statusCode], ...(typeof b.code === 'string' ? { code: b.code } : {}) };
		}
		if (res.statusCode >= 500 && !res.locals.errorContractApplied && body && typeof body === 'object' && !Array.isArray(body) && ((body as Record<string, unknown>).success === false || typeof (body as Record<string, unknown>).message === 'string' || typeof (body as Record<string, unknown>).error === 'string')) {
			const b = body as Record<string, unknown>;
			const message = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : '';
			const deliberate = ARABIC_TEXT.test(message) && !LEAKY.test(message);
			const traceId = newTraceId();
			if (deliberate) {
				body = { success: false, message, ...(typeof b.code === 'string' ? { code: b.code } : {}), traceId };
			} else {
				logger.error(`[safeServerErrors] a controller answered ${res.statusCode} with an unsafe/raw text; replaced [trace ${traceId}]: ${message || '(no message)'}`);
				body = { success: false, message: UNEXPECTED_ERROR_MESSAGE, code: UNEXPECTED_ERROR_CODE, traceId };
			}
		}
		return originalJson(body);
	}) as Response['json'];
	next();
}
