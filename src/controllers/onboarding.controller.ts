import { Request, Response, NextFunction } from 'express';
import { onboardingUploadSchema } from '../dtos/onboarding.dto';
import { AppError } from '../utils/app-error';
import { uploadMulterFile } from '../utils/cloudinary-storage';
import { onboardingService } from '../services/onboarding.service';

export async function uploadOnboardingDocument(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError('ملف مستند الهوية مطلوب', 400);
    const parsed = onboardingUploadSchema.safeParse(req.body || {});
    if (!parsed.success) throw new AppError('نوع مستند onboarding غير صحيح', 400);
    const stored = await uploadMulterFile(req.file, `waseetai/clients/${req.user!.id}/onboarding`);
    const data = await onboardingService.saveUpload(req.user!.id, { documentType: parsed.data.documentType, documentUrl: stored.url, documentName: stored.fileName });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
}

export async function getOnboardingStatus(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await onboardingService.getStatus(req.user!.id) }); } catch (error) { next(error); }
}
