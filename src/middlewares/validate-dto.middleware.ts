import { Request, Response, NextFunction } from 'express';
import { z, ZodError, ZodSchema } from 'zod';
import { AppError } from '../utils/app-error';

/**
 * Generic DTO validation middleware utilizing Zod schemas.
 * Validates request body against the provided schema and replaces req.body with parsed/transformed data.
 */
export const validateDto = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message
        }));
        res.status(400).json({
          success: false,
          message: 'خطأ في التحقق من البيانات المرسلة (Validation Error)',
          errors
        });
        return;
      }
      next(new AppError('حدث خطأ داخلي أثناء أتمتة التحقق', 500));
    }
  };
};
