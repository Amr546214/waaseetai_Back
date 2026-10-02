import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { AI_FEATURE_UNAVAILABLE_CODE } from '../services/ai/ai-feature-unavailable';

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

  if (err instanceof AppError) {
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
