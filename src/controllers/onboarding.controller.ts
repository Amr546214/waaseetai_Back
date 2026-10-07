import { Request, Response, NextFunction } from 'express';
import { OnboardingStatus, KYCStatus } from '@prisma/client';
import { onboardingUploadSchema, rejectOnboardingSchema } from '../dtos/onboarding.dto';
import { AppError } from '../utils/app-error';
import { uploadMulterFile } from '../utils/cloudinary-storage';
import { onboardingService } from '../services/onboarding.service';

export async function uploadOnboardingDocument(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError('ملف مستند الهوية مطلوب', 400);
    const parsed = onboardingUploadSchema.safeParse(req.body || {});
    if (!parsed.success) throw new AppError('نوع مستند onboarding غير صحيح', 400);
    const stored = await uploadMulterFile(req.file, `waseetai/clients/${req.user!.id}/onboarding`, undefined, true);
    const data = await onboardingService.saveUpload(req.user!.id, { documentType: parsed.data.documentType, documentUrl: stored.privateRef as string, documentName: stored.fileName });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
}

export async function getOnboardingStatus(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await onboardingService.getStatus(req.user!.id) }); } catch (error) { next(error); }
}

// ===== Admin: Client Onboarding Review =====

export async function adminListOnboarding(req: Request, res: Response, next: NextFunction) {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(OnboardingStatus).includes(rawStatus as OnboardingStatus) ? rawStatus as OnboardingStatus : undefined;
    if (rawStatus && !status) throw new AppError('حالة الـ onboarding غير صحيحة', 400);
    const data = await onboardingService.listOnboarding(status, Number(req.query.page) || 1, Number(req.query.limit) || 10);
    res.json({ success: true, message: 'تم جلب قائمة طلبات التحقق بنجاح', data });
  } catch (error) { next(error); }
}

export async function adminGetOnboarding(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await onboardingService.getOnboarding(String(req.params.id));
    res.json({ success: true, data });
  } catch (error) { next(error); }
}

export async function adminApproveOnboarding(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await onboardingService.approveOnboarding(String(req.params.id));
    res.json({ success: true, message: 'تم اعتماد طلب التحقق بنجاح', data });
  } catch (error) { next(error); }
}

export async function adminRejectOnboarding(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = rejectOnboardingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('سبب الرفض مطلوب', 400);
    const data = await onboardingService.rejectOnboarding(String(req.params.id), parsed.data);
    res.json({ success: true, message: 'تم رفض طلب التحقق', data });
  } catch (error) { next(error); }
}

// ===== Admin: Provider KYC Review =====

export async function adminListProviderKyc(req: Request, res: Response, next: NextFunction) {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(KYCStatus).includes(rawStatus as KYCStatus) ? rawStatus as KYCStatus : undefined;
    if (rawStatus && !status) throw new AppError('حالة KYC غير صحيحة', 400);
    const data = await onboardingService.listProviderKyc(status, Number(req.query.page) || 1, Number(req.query.limit) || 10);
    res.json({ success: true, message: 'تم جلب قائمة طلبات التحقق من المزودين بنجاح', data });
  } catch (error) { next(error); }
}

export async function adminApproveProviderKyc(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await onboardingService.approveProviderKyc(String(req.params.userId));
    res.json({ success: true, message: 'تم اعتماد التحقق من المزود بنجاح', data });
  } catch (error) { next(error); }
}

export async function adminRejectProviderKyc(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = rejectOnboardingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('سبب الرفض مطلوب', 400);
    const data = await onboardingService.rejectProviderKyc(String(req.params.userId), parsed.data);
    res.json({ success: true, message: 'تم رفض التحقق من المزود', data });
  } catch (error) { next(error); }
}
