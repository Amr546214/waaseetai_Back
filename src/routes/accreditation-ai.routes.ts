import express, { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { AccountType } from '@prisma/client';
import { authenticate, authorizeActiveRole, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { accreditationAiService } from '../services/accreditation-ai.service';
import { memoryUpload, uploadMulterFile } from '../utils/cloudinary-storage';
import { PROOF_ALLOWED_MIME_TYPES, PROOF_MAX_BYTES, PROOF_MAX_FILES, completeUpload, failUpload, listUploads, proofRequirements, publicUpload, removeUpload, startUpload } from '../services/accreditation-proof.service';
import { ProofFileType } from '@prisma/client';

const router = express.Router();
router.use(authenticate, requireActiveUser, authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY));

const ALLOWED_ACCREDITATION_MIME_TYPES = new Set<string>(PROOF_ALLOWED_MIME_TYPES);
const upload = memoryUpload({ fileSize: PROOF_MAX_BYTES, files: PROOF_MAX_FILES, allowedMimeTypes: ALLOWED_ACCREDITATION_MIME_TYPES });

const fieldErrors = (list: Array<[string, string]>) => new AppError(list[0][1], 400, list.map(([field, message]) => ({ path: field, field, message, code: 'required' })));
const asStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.filter((v: unknown): v is string => typeof v === 'string'); } catch { /* a single plain string */ }
    return [value];
  }
  return [];
};

/**
 * Primary Endpoint: POST /api/provider/accreditation/submit or /api/accreditation/submit
 * Submits work sample for technical accreditation & stores it for human review (AI evaluation is paused until WaseetAI supports it)
 */
router.post('/submit', aiLimiter, upload.array('files', PROOF_MAX_FILES), async (req: Request, res: Response, next) => {
  try {
    const user = req.user!;
    let { providerSpecialtyId, title, description, technologiesUsed, projectUrl, githubUrl, attachments, proofIds, resubmitSampleId } = req.body;

    title = typeof title === 'string' ? title.trim() : '';
    description = typeof description === 'string' ? description.trim() : '';
    // every invalid field is named (the form shows each one at its input)
    const invalid: Array<[string, string]> = [];
    if (!providerSpecialtyId) invalid.push(['providerSpecialtyId', 'اختر التخصص']);
    if (title.length < 3) invalid.push(['title', 'عنوان النموذج مطلوب (3 أحرف على الأقل)']);
    if (description.length < 10) invalid.push(['description', 'الوصف الفني مطلوب (10 أحرف على الأقل)']);
    if (invalid.length) throw fieldErrors(invalid);

    const validateOptionalUrl = (value: unknown, field: string, label: string) => {
      if (!value) return undefined;
      if (typeof value !== 'string') throw fieldErrors([[field, `${label} غير صالح`]]);
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        return parsed.toString();
      } catch {
        throw fieldErrors([[field, `${label} يجب أن يبدأ بـ http أو https`]]);
      }
    };
    projectUrl = validateOptionalUrl(projectUrl, 'projectUrl', 'رابط المشروع');
    githubUrl = validateOptionalUrl(githubUrl, 'githubUrl', 'رابط GitHub');

    if (typeof technologiesUsed === 'string') {
      try {
        technologiesUsed = JSON.parse(technologiesUsed);
      } catch {
        technologiesUsed = technologiesUsed.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(technologiesUsed)) {
      technologiesUsed = [];
    }
    technologiesUsed = technologiesUsed
      .filter((value: unknown): value is string => typeof value === 'string')
      .map((value: string) => value.trim())
      .filter(Boolean)
      .slice(0, 30);

    const specialty = await prisma.providerSpecialty.findFirst({ where: { OR: [{ id: String(providerSpecialtyId) }, { specialtyId: String(providerSpecialtyId) }], providerProfile: { userId: user.id } }, select: { id: true } });
    if (!specialty) throw new AppError('التخصص غير مرتبط بحساب مقدم الخدمة', 403);

    // files sent WITH the request are uploaded private and recorded as completed uploads of this user for this request; the ids of files uploaded earlier
    // (upload-proof) are verified by the service. A URL in `attachments` is accepted only when it is the private reference of one of the user's own uploads.
    const ids: string[] = asStringList(proofIds);
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        const row = await startUpload(prisma, { userId: user.id, providerSpecialtyId: specialty.id, fileName: file.originalname, mimeType: file.mimetype, bytes: file.size });
        try {
          const stored = await uploadMulterFile(file, `waseetai/accreditation/${user.id}/proofs`, undefined, true);
          await completeUpload(prisma, row.id, stored.privateRef!, stored.bytes ?? file.size);
          ids.push(row.id);
        } catch (error) { await failUpload(prisma, row.id); throw error; }
      }
    }

    const result = await accreditationAiService.submitAccreditationSample({
      userId: user.id,
      providerSpecialtyId,
      title,
      description,
      technologiesUsed,
      projectUrl,
      githubUrl,
      attachments: asStringList(attachments),
      proofIds: ids,
      resubmitSampleId: typeof resubmitSampleId === 'string' && resubmitSampleId ? resubmitSampleId : undefined
    });

    res.status(200).json({
      success: true,
      message: result.aiEvaluation.message,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/accreditation/samples or /api/provider/accreditation/samples
 */
router.get('/samples', async (req: Request, res: Response, next) => {
  try {
    const user = req.user!;
    const result = await accreditationAiService.getProviderAccreditationSamples(user.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/accreditation/samples/:id or /api/provider/accreditation/samples/:id
 */
router.get('/samples/:id', async (req: Request, res: Response, next) => {
  try {
    const user = req.user!;
    const id = req.params['id'] as string;
    const result = await accreditationAiService.getAccreditationSampleById(user.id, id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * Proof file uploader endpoint (backward compatibility & instant file upload)
 */
router.post('/upload-proof', upload.single('file'), async (req: Request, res: Response, next) => {
  try {
    const { specialtyId, providerSpecialtyId } = req.body;
    const file = req.file;
    const target = String(providerSpecialtyId || specialtyId || '');

    if (!target) throw fieldErrors([['providerSpecialtyId', 'اختر التخصص قبل رفع ملف الإثبات']]);
    if (!file) throw fieldErrors([['files', 'اختر ملف الإثبات للرفع']]);

    const user = req.user!;
    const profile = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
    if (!profile) throw new AppError('Provider profile not found', 404);

    // The file is recorded against THIS user and THIS request before it is stored; it counts only once the upload is COMPLETED.
    const row = await startUpload(prisma, { userId: user.id, providerSpecialtyId: target, fileName: file.originalname, mimeType: file.mimetype, bytes: file.size, kind: ProofFileType.WORK_SAMPLE });
    try {
      const stored = await uploadMulterFile(file, `waseetai/accreditation/${user.id}/proofs`, undefined, true);
      const done = await completeUpload(prisma, row.id, stored.privateRef!, stored.bytes ?? file.size);
      // The private reference is never returned: the caller keeps the upload id and the metadata only.
      res.status(200).json({ success: true, proofId: done.id, data: publicUpload(done), fileName: stored.fileName, fileSize: (stored.bytes / 1024 / 1024).toFixed(2) + ' MB' });
    } catch (error) { await failUpload(prisma, row.id); throw error; }
  } catch (error) {
    next(error);
  }
});

/** What this path requires (types, sizes, count): the form shows it before the user uploads. */
router.get('/proof-requirements', (_req: Request, res: Response) => { res.json({ success: true, data: proofRequirements() }); });

/** The caller's completed proof documents for one request (provider specialty) that are not attached to a decided request. */
router.get('/proofs', async (req: Request, res: Response, next) => {
  try {
    const target = String(req.query.providerSpecialtyId || '');
    if (!target) throw fieldErrors([['providerSpecialtyId', 'التخصص مطلوب']]);
    const sampleId = typeof req.query.sampleId === 'string' ? req.query.sampleId : null;
    res.json({ success: true, data: await listUploads(prisma, req.user!.id, target, sampleId) });
  } catch (error) { next(error); }
});

/** Deleting a required document restores the "missing" state (the row is cancelled and no longer counts). */
router.delete('/proofs/:id', async (req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: await removeUpload(prisma, req.user!.id, String(req.params['id'])) });
  } catch (error) { next(error); }
});

import { z } from 'zod';
import { llmClient } from '../services/llm/llm.client';

const AccreditationDraftSchema = z.object({
  title: z.string().min(5).max(160),
  overview: z.string().min(20).max(500),
  architecturePoints: z.array(z.string().min(10).max(300)).min(2).max(5),
  performanceAndSecurityPoints: z.array(z.string().min(10).max(300)).min(2).max(4),
  technologiesUsed: z.array(z.string().min(1).max(50)).min(3).max(8),
});

const cleanLine = (s: string): string =>
  s.replace(/^[\s•\-*#\d.)]+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();

/**
 * POST /api/provider/accreditation/ai-suggest
 * Generates or enhances the technical work sample draft (title, multi-line architectural description, and tech stack) for Step 2.
 */
router.post('/ai-suggest', aiLimiter, async (req: Request, res: Response, next) => {
  try {
    const user = req.user!;
    const specialtyName = typeof req.body?.specialtyName === 'string' ? req.body.specialtyName.trim() : 'تطوير البرمجيات';
    const subSpecialties = asStringList(req.body?.subSpecialties);
    const currentTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const currentDescription = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const currentTechs = asStringList(req.body?.technologiesUsed);

    const profile = await prisma.providerProfile.findUnique({
      where: { userId: user.id },
      select: { skills: true, headline: true },
    });
    const profileSkills = Array.isArray(profile?.skills)
      ? (profile!.skills as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 15)
      : [];

    const system = `أنت مستشار تقني ومعماري خبير على منصة "وسيط AI".
مهمتك مساعدة مقدم الخدمة في صياغة أو تحسين بيانات نموذج العمل الفني للاعتماد باللغة العربية الاحترافية والمنسقة (بدون رموز ماركداون مثل ** أو ##).
القواعد:
1. إذا كان المستخدم قد كتب عنواناً أو وصفاً مبدئياً، قم بتحسينه وتوسيعه تقنياً ومعمارياً مع الحفاظ على فكرته الأساسية.
2. إذا لم يكتب المستخدم عنواناً أو وصفاً، اقترح نموذج عمل فني احترافي ومتكامل يناسب التخصص المختار (${specialtyName}${subSpecialties.length ? ' - ' + subSpecialties.join('، ') : ''}).
3. قسّم الوصف الفني المعماري إلى:
   - overview: فقرة تمهيدية واضحة تشرح فكرة المشروع والهدف منه (جملتين إلى 3 جمل).
   - architecturePoints: من 3 إلى 4 نقاط تفصيلية تشرح البنية المعمارية، تقسيم المكونات، أنماط التصميم (Design Patterns)، وإدارة الحالة أو البيانات.
   - performanceAndSecurityPoints: من 2 إلى 3 نقاط تشرح تحسينات الأداء، الأمان، إمكانية الوصول (Accessibility)، واختبارات الجودة.
4. اقترح في technologiesUsed من 4 إلى 7 تقنيات ومكتبات حقيقية ومناسبة جداً للتخصص والمشروع (بأسمائها القياسية بالإنجليزية).`;

    const result = await llmClient.generateJson({
      feature: 'accreditation-sample-draft',
      userId: user.id,
      schema: AccreditationDraftSchema,
      system,
      input: {
        specialtyName,
        subSpecialties,
        providerSkills: profileSkills,
        currentTitle: currentTitle || null,
        currentDescription: currentDescription || null,
        currentTechs,
      },
      effort: 'medium',
      maxOutputTokens: 1400,
      timeoutMs: 25_000,
    });

    const formattedDescription = [
      'نظرة عامة على المشروع:',
      result.data.overview.replace(/\*\*/g, '').trim(),
      '',
      'البنية المعمارية وأنماط التصميم:',
      ...result.data.architecturePoints.map((p) => `• ${cleanLine(p)}`),
      '',
      'الأداء والأمان وضمان الجودة:',
      ...result.data.performanceAndSecurityPoints.map((p) => `• ${cleanLine(p)}`),
    ].join('\n');

    res.status(200).json({
      success: true,
      data: {
        title: result.data.title.replace(/\*\*/g, '').trim(),
        description: formattedDescription,
        technologiesUsed: result.data.technologiesUsed.map((t) => t.replace(/\*\*/g, '').trim()).filter(Boolean),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

