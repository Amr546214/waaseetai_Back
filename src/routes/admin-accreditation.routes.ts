import { Router, Request, Response, NextFunction } from 'express';
import { AccountType, AccreditationStatus } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { accreditationAiService } from '../services/accreditation-ai.service';
import { rejectAccreditationSchema, requestCompletionSchema, specialtyReviewDecisionSchema } from '../dtos/accreditation.dto';
import { specialtyAdminReviewService, specialtyReviewQueryService } from '../services/specialty-admin-review.service';
import { AppError, zodAppError } from '../utils/app-error';
import { adminActor } from '../utils/admin-actor';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('specialties.approve'));

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
    const data = await accreditationAiService.adminApproveSample(String(req.params.id), adminActor(req));
    res.json({ success: true, message: 'تم اعتماد نموذج الاعتماد بنجاح', data });
  } catch (error) { next(error); }
});

router.post('/samples/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = rejectAccreditationSchema.safeParse(req.body);
    if (!parsed.success) throw zodAppError(parsed.error.issues, 'سبب الرفض مطلوب', { rejectionReason: 'سبب الرفض مطلوب' });
    const data = await accreditationAiService.adminRejectSample(String(req.params.id), parsed.data.rejectionReason, adminActor(req), parsed.data.internalNote);
    res.json({ success: true, message: 'تم رفض نموذج الاعتماد', data });
  } catch (error) { next(error); }
});

// Batch B T1: ask the provider to complete / fix the request. `userNote` is shown to the provider, `internalNote` never leaves the admin API.
router.post('/samples/:id/request-completion', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = requestCompletionSchema.safeParse(req.body);
    if (!parsed.success) throw zodAppError(parsed.error.issues, parsed.error.issues[0]?.message || 'بيانات الطلب غير صحيحة', { userNote: 'اكتب ملاحظة واضحة للمستخدم (3 أحرف على الأقل)' });
    const data = await accreditationAiService.adminRequestCompletion(String(req.params.id), parsed.data, adminActor(req));
    res.json({ success: true, message: 'تم إرسال طلب الاستكمال للمستخدم', data });
  } catch (error) { next(error); }
});

// Specialty review queue (UNDER_AI_REVIEW by default) and its decided history; ?status=pending|approved|rejected|all
router.get('/specialties', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await specialtyReviewQueryService.list({ status: typeof req.query.status === 'string' ? req.query.status : undefined, search: typeof req.query.search === 'string' ? req.query.search : undefined, page: Number(req.query.page), limit: Number(req.query.limit) });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/specialties/:providerSpecialtyId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await specialtyReviewQueryService.get(String(req.params.providerSpecialtyId));
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// BE-3(b): POST /api/admin/accreditation/specialties/:providerSpecialtyId/decision { decision: APPROVED|REJECTED, reason }
router.post('/specialties/:providerSpecialtyId/decision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = specialtyReviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) throw zodAppError(parsed.error.issues, parsed.error.issues[0]?.message || 'بيانات القرار غير صحيحة', { reason: 'سبب القرار مطلوب (5 أحرف على الأقل)', decision: 'نوع القرار غير صحيح' });
    const data = await specialtyAdminReviewService.decide(req.user!.id, String(req.params.providerSpecialtyId), parsed.data);
    res.json({ success: true, message: parsed.data.decision === 'APPROVED' ? 'تم اعتماد التخصص' : 'تم رفض التخصص', data });
  } catch (error) { next(error); }
});

export default router;
