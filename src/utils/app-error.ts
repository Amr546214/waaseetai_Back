export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly errors?: any[];
  /** A fixed, developer-defined marker (UPPER_SNAKE) the client can branch on; forwarded in the response body. Never built from user input. */
  public readonly code?: string;

  constructor(message: string, statusCode: number, errors?: any[], code?: string) {
    super(message);

    this.statusCode = statusCode;
    this.isOperational = true;
    this.errors = errors;
    if (code) this.code = code;

    // Capture the stack trace, excluding the constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }
}

export interface FieldErrorItem { field: string; path: string; message: string; code?: string }

/** One `errors[]` entry in the shape validate-dto.middleware.ts produces ({field, path, message}); the admin forms put `message` under the control named `field`. */
export const fieldErrorItem = (field: string, message: string, code?: string): FieldErrorItem => ({ field, path: field, message, ...(code ? { code } : {}) });

/** 400 (or `status`) that names the offending field: same body as a plain AppError plus `errors:[{field,message}]`. The top-level message is kept as given. */
export const fieldError = (field: string, message: string, status = 400, summary: string = message): AppError =>
  new AppError(summary, status, [fieldErrorItem(field, message)]);

/** Several fields at once. */
export const fieldErrors = (summary: string, items: Array<{ field: string; message: string }>, status = 400): AppError =>
  new AppError(summary, status, items.map((i) => fieldErrorItem(i.field, i.message)));

type ZodIssueLike = { path: PropertyKey[]; message: string; code?: string };
const ARABIC = /[\u0600-\u06FF]/;
/**
 * zod issues -> errors[] (path joined with '.'; an issue with no path keeps field ''; the FE ignores '' and shows the summary generically).
 * `arabic` maps a field to the Arabic text to show when zod's own message for it is a default English one (custom Arabic zod messages are kept).
 */
export const zodFieldErrors = (issues: ZodIssueLike[], arabic: Record<string, string> = {}): FieldErrorItem[] =>
  issues.map((i) => {
    const field = i.path.map(String).join('.');
    return fieldErrorItem(field, !ARABIC.test(i.message) && arabic[field] ? arabic[field] : i.message, i.code);
  });

/** AppError from a failed zod parse: `summary` (or the first issue message) as message, every issue as a field error. */
export const zodAppError = (issues: ZodIssueLike[], summary?: string, arabic: Record<string, string> = {}, status = 400): AppError =>
  new AppError(summary ?? issues[0]?.message ?? 'بيانات غير صحيحة', status, zodFieldErrors(issues, arabic));
