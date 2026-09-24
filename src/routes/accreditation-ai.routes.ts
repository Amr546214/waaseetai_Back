import express, { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { accreditationAiService } from '../services/accreditation-ai.service';
import { memoryUpload, uploadMulterFile } from '../utils/cloudinary-storage';

const router = express.Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY));

const ALLOWED_ACCREDITATION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed'
]);
const upload = memoryUpload({ fileSize: 15 * 1024 * 1024, files: 10, allowedMimeTypes: ALLOWED_ACCREDITATION_MIME_TYPES });

/**
 * Primary Endpoint: POST /api/provider/accreditation/submit or /api/accreditation/submit
 * Submits work sample for technical accreditation & runs OpenAI GPT-4o evaluation
 */
router.post('/submit', aiLimiter, upload.array('files', 10), async (req: Request, res: Response, next) => {
  try {
    const user = req.user!;
    let { providerSpecialtyId, title, description, technologiesUsed, projectUrl, githubUrl, attachments } = req.body;

    title = typeof title === 'string' ? title.trim() : '';
    description = typeof description === 'string' ? description.trim() : '';
    if (!providerSpecialtyId || title.length < 3 || description.length < 10) {
      throw new AppError('يرجى تزويد التخصص والعنوان والوصف الفني للنموذج', 400);
    }

    const validateOptionalUrl = (value: unknown) => {
      if (!value) return undefined;
      if (typeof value !== 'string') throw new AppError('رابط المشروع غير صالح', 400);
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        return parsed.toString();
      } catch {
        throw new AppError('روابط المشروع يجب أن تبدأ بـ http أو https', 400);
      }
    };
    projectUrl = validateOptionalUrl(projectUrl);
    githubUrl = validateOptionalUrl(githubUrl);

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

    let parsedAttachments: string[] = [];
    if (typeof attachments === 'string') {
      try {
        parsedAttachments = JSON.parse(attachments);
      } catch {
        parsedAttachments = [attachments];
      }
    } else if (Array.isArray(attachments)) {
      parsedAttachments = attachments;
    }

    if (req.files && Array.isArray(req.files)) {
      const uploaded = await Promise.all(req.files.map(file => uploadMulterFile(file, `waseetai/accreditation/${user.id}`)));
      parsedAttachments.push(...uploaded.map(file => file.url));
    }

    const result = await accreditationAiService.evaluateAccreditationSample({
      userId: user.id,
      providerSpecialtyId,
      title,
      description,
      technologiesUsed,
      projectUrl,
      githubUrl,
      attachments: parsedAttachments
    });

    res.status(200).json({
      success: true,
      message: 'تم فحص نموذج الاعتماد الفني بالذكاء الاصطناعي بنجاح',
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
    const { specialtyId, fileType } = req.body;
    const file = req.file;

    if (!file) throw new AppError('File is required', 400);

    const user = req.user!;
    const profile = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
    if (!profile) throw new AppError('Provider profile not found', 404);

    const stored = await uploadMulterFile(file, `waseetai/accreditation/${user.id}/proofs`);

    res.status(200).json({
      success: true,
      fileUrl: stored.url,
      fileName: stored.fileName,
      fileSize: (stored.bytes / 1024 / 1024).toFixed(2) + ' MB'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
