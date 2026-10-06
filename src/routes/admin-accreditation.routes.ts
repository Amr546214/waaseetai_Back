import { Router, Request, Response, NextFunction } from 'express';
import { AccountType, AccreditationStatus } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { accreditationAiService } from '../services/accreditation-ai.service';
import { rejectAccreditationSchema, specialtyReviewDecisionSchema } from '../dtos/accreditation.dto';
import { specialtyAdminReviewService } from '../services/specialty-admin-review.service';
import { AppError } from '../utils/app-error';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

router.get('/samples', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(AccreditationStatus).includes(rawStatus as AccreditationStatus) ? rawStatus as AccreditationStatus : undefined;
    if (rawStatus && !status) throw new AppError('حالة الاعتماد غير صحيحة', 400);
    const data = await accreditationAiService.listAllSamples(status, Number(req.query.page) || 1, Number(req.query.limit) || 10);
    res.json({ success: true, message: 'تم جلب قائمة نماذج الاعتماد بنجاح', data });
  } catch (error) { next(error); }
});

router.get('/samples/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await accreditationAiService.getSampleByIdAdmin(String(req.params.id));
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/samples/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await accreditationAiService.adminApproveSample(String(req.params.id));
    res.json({ success: true, message: 'تم اعتماد نموذج الاعتماد بنجاح', data });
  } catch (error) { next(error); }
});

router.post('/samples/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = rejectAccreditationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('سبب الرفض مطلوب', 400);
    const data = await accreditationAiService.adminRejectSample(String(req.params.id), parsed.data.rejectionReason);
    res.json({ success: true, message: 'تم رفض نموذج الاعتماد', data });
  } catch (error) { next(error); }
});

// BE-3(b): POST /api/admin/accreditation/specialties/:providerSpecialtyId/decision { decision: APPROVED|REJECTED, reason }
router.post('/specialties/:providerSpecialtyId/decision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = specialtyReviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'بيانات القرار غير صحيحة', 400);
    const data = await specialtyAdminReviewService.decide(req.user!.id, String(req.params.providerSpecialtyId), parsed.data);
    res.json({ success: true, message: parsed.data.decision === 'APPROVED' ? 'تم اعتماد التخصص' : 'تم رفض التخصص', data });
  } catch (error) { next(error); }
});

export default router;
