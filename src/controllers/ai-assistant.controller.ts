import { NextFunction, Request, Response } from 'express';
import { projectFitService } from '../services/ai-features/project-fit.service';
import { AppError } from '../utils/app-error';

// Feature #14 (project fit for a provider) is built in-house on the internal LlmClient: a real model answer grounded in the project
// and provider fields that were sent, or an explicit 503 — never an invented analysis. Read-only: no database write.

export const analyzeProjectForProvider = async (req: Request, res: Response, next?: NextFunction): Promise<void> => {
  try {
    const projectId = String(req.params?.projectId ?? req.body?.projectId ?? '').trim();
    if (!projectId) throw new AppError('معرّف المشروع مطلوب', 400);
    const userId = (req as any).user?.id;
    const data = await projectFitService.analyze(userId, projectId);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (next) return next(error);
    const status = (error as any)?.statusCode ?? 500;
    res.status(status).json({ success: false, message: (error as any)?.message, code: (error as any)?.code });
  }
};
