import { Router, Request, Response, NextFunction } from 'express';
import { SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { evaluateSpecialtyWithAI } from '../controllers/specialty-ai.controller';
import { memoryUpload, uploadMulterFile } from '../utils/cloudinary-storage';
import { SPECIALTY_UPLOAD_MIME_TYPES } from '../utils/upload-mime-types';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { requireOwnedProviderSpecialtyFromBody, requireOwnedProviderSpecialtyFromParam } from '../utils/provider-specialty-access';

const router = Router();

const upload = memoryUpload({ fileSize: 15 * 1024 * 1024, files: 30, allowedMimeTypes: SPECIALTY_UPLOAD_MIME_TYPES });
const providerAuth = [
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)
] as const;

router.post(
  '/submit-proof',
  ...providerAuth,
  upload.any(),
  requireOwnedProviderSpecialtyFromBody,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providerSpecialtyId = String(req.body.providerSpecialtyId || '');
      const sampleCount = parseInt(req.body.sampleCount || '0', 10);
      const files = (req.files as Express.Multer.File[]) || [];

      if (!providerSpecialtyId) {
        res.status(400).json({ success: false, message: 'providerSpecialtyId is a required parameter.' });
        return;
      }

      const existingSpecialty = await prisma.providerSpecialty.findUnique({
        where: { id: providerSpecialtyId },
      });

      if (!existingSpecialty) {
        res.status(404).json({ success: false, message: 'Target ProviderSpecialty record not found.' });
        return;
      }

      const fileMap: { [fieldName: string]: Express.Multer.File[] } = {};
      files.forEach((f) => {
        if (!fileMap[f.fieldname]) fileMap[f.fieldname] = [];
        fileMap[f.fieldname].push(f);
      });

      const cloudFiles = new Map<Express.Multer.File, Awaited<ReturnType<typeof uploadMulterFile>>>();
      await Promise.all(files.map(async file => {
        const stored = await uploadMulterFile(file, `waseetai/specialties/${providerSpecialtyId}/${file.fieldname.startsWith('proofFiles_') ? 'proofs' : 'samples'}`);
        cloudFiles.set(file, stored);
      }));

      await prisma.$transaction(async (tx) => {
        await tx.workSample.deleteMany({ where: { providerSpecialtyId } });

        for (let i = 0; i < sampleCount; i++) {
          const title = req.body[`sampleTitle_${i}`] || `نموذج عمل رقم ${i + 1}`;
          const description = req.body[`sampleDescription_${i}`] || null;
          let technologies: string[] = [];
          try {
            const parsed = JSON.parse(req.body[`sampleTechnologies_${i}`] || '[]');
            if (Array.isArray(parsed)) technologies = parsed.map(String).map(value => value.trim()).filter(Boolean).slice(0, 15);
          } catch {}

          const publicFiles = fileMap[`publicSample_${i}`] || [];
          let publicUrl = '';
          let mimeType = 'application/octet-stream';
          let fileBytes = 0;

          if (publicFiles.length > 0) {
            const publicFile = publicFiles[0];
            publicUrl = cloudFiles.get(publicFile)!.url;
            mimeType = publicFile.mimetype;
            fileBytes = publicFile.size;
          } else {
            publicUrl = '';
          }

          const createdSample = await tx.workSample.create({
            data: {
              providerSpecialtyId,
              title: String(title).substring(0, 150),
              description: description ? String(description) : null,
              technologies,
              publicSampleUrl: publicUrl,
              mimeType,
              fileBytes,
              watermarkLabel: 'وسيط AI',
            },
          });

          const proofFiles = fileMap[`proofFiles_${i}`] || [];
          for (const proof of proofFiles) {
            const storedProof = cloudFiles.get(proof)!;
            await tx.proofAttachment.create({
              data: {
                workSampleId: createdSample.id,
                fileName: storedProof.fileName.substring(0, 255),
                fileUrl: storedProof.url,
                mimeType: proof.mimetype,
                fileBytes: proof.size,
                isConfidential: true,
                watermarkLabel: 'وسيط AI',
              },
            });
          }
        }

        await tx.providerSpecialty.update({
          where: { id: providerSpecialtyId },
          data: { status: SpecialtyVerificationStatus.UNDER_AI_REVIEW },
        });
      });

      res.status(201).json({
        success: true,
        message: 'تم رفع كافة نماذج ومستندات التحقق بنجاح وبسرية تامة.',
        data: { providerSpecialtyId, samplesProcessed: sampleCount },
      });
    } catch (error: any) {
      console.error('[Specialty Proof Upload Error]:', error);
      res.status(500).json({ success: false, message: 'حدث خطأ داخلي أثناء معالجة الملفات المرفوعة.', error: error?.message });
    }
  }
);

router.post('/:id/ai-evaluate', ...providerAuth, requireOwnedProviderSpecialtyFromParam, aiLimiter, evaluateSpecialtyWithAI);

router.get('/:id/status', ...providerAuth, requireOwnedProviderSpecialtyFromParam, async (req: Request, res: Response): Promise<void> => {
  try {
    const providerSpecialtyId = String(req.params.id);

    const record = await prisma.providerSpecialty.findUnique({
      where: { id: providerSpecialtyId },
      include: {
        specialty: { select: { id: true, name: true } },
        workSamples: {
          include: {
            proofs: {
              select: { id: true, fileName: true, mimeType: true, fileBytes: true, isConfidential: true },
            },
          },
        },
        aiAuditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, modelVersion: true, latencyMs: true, createdAt: true, evaluationResult: true },
        },
      },
    });

    if (!record) {
      res.status(404).json({ success: false, message: 'Provider specialty status record not found.' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        id: record.id,
        specialty: record.specialty,
        subSpecialties: record.subSpecialties,
        status: record.status,
        isActive: record.isActive,
        scores: {
          aiScore: record.aiScore || 0,
          feasibilityScore: record.feasibilityScore || 0,
          clarityScore: record.clarityScore || 0,
          ownershipCredibility: record.ownershipCredibility || 0,
        },
        feedback: record.aiFeedback || { summary: '', strengths: [], warnings: [], corrections: [] },
        samplesCount: record.workSamples.length,
        workSamples: record.workSamples,
        latestAudit: record.aiAuditLogs[0] || null,
        updatedAt: record.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('[Specialty Status Fetch Error]:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve provider specialty status.', error: error?.message });
  }
});

export default router;
