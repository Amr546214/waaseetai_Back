import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../utils/app-error';

export const validateRequest = (schema: z.ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const formattedErrors = error.issues.map((err: any) => ({
          path: err.path.join('.'),
          message: err.message,
        }));
        
        next(new AppError('Validation Error', 400, formattedErrors));
      } else {
        next(new AppError('Internal Server Error during validation', 500));
      }
    }
  };
};
