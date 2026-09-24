import { Request, Response } from 'express';
import { SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { geminiClient, GeminiImageInput } from '../services/ai/gemini/gemini.client';
import { geminiModelConfig } from '../config/ai/gemini.config';
import { fetchRemoteImage } from '../utils/remote-image-fetch';
import { SPECIALTY_AUDIT_SYSTEM_PROMPT, AiSpecialtyEvaluationResult } from '../prompts/specialties.prompt';

// F9 — Provider Specialty AI Evaluation, migrated to the shared Gemini
// Vision foundation.
//
// Fallback decision: the previous implementation had TWO independent,
// inconsistent hardcoded "success" score sets — this file's own
// (89.5/92.0/86.0/91.0, used whenever OPENAI_API_KEY was unset) and a
// DIFFERENT one on the frontend (91.0/94.5/88.0/92.0) — both presented as
// real AI results, plus fabricated AiAuditLog token counts (480/290/770)
// persisted alongside the fake score. All of that is removed. If Gemini is
// unavailable, the image fetch fails for every candidate image, or Gemini's
// output fails validation, this now returns an honest error and rolls the
// specialty back to PENDING_PROOF (the same recovery state the pre-existing
// exception handler already used) — never a fabricated passing or failing
// evaluation.

const AI_SCORE_THRESHOLD = 70.0;
const OWNERSHIP_CREDIBILITY_THRESHOLD = 65.0;
const MAX_VISION_IMAGES = 4;

function truncate(value: string | null | undefined, maxLength = 600): string {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : (text || 'Not provided.');
}

const SPECIALTY_EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    aiScore: { type: 'number', description: '0.0 to 100.0' },
    feasibilityScore: { type: 'number', description: '0.0 to 100.0' },
    clarityScore: { type: 'number', description: '0.0 to 100.0' },
    ownershipCredibility: { type: 'number', description: '0.0 to 100.0' },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    corrections: { type: 'array', items: { type: 'string' } },
    isEligibleForTesting: { type: 'boolean' }
  },
  required: ['aiScore', 'feasibilityScore', 'clarityScore', 'ownershipCredibility', 'summary', 'strengths', 'warnings', 'corrections', 'isEligibleForTesting']
};

const isBoundedScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

// Rejects anything that doesn't genuinely satisfy the application contract —
// wrong types, out-of-range scores, or malformed arrays are all invalid,
// never silently coerced into a passable-looking evaluation.
function isValidSpecialtyEvaluation(value: unknown): value is AiSpecialtyEvaluationResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    isBoundedScore(v.aiScore) &&
    isBoundedScore(v.feasibilityScore) &&
    isBoundedScore(v.clarityScore) &&
    isBoundedScore(v.ownershipCredibility) &&
    typeof v.summary === 'string' && v.summary.trim().length > 0 &&
    isStringArray(v.strengths) &&
    isStringArray(v.warnings) &&
    isStringArray(v.corrections) &&
    typeof v.isEligibleForTesting === 'boolean'
  );
}

function isFetchableImageUrl(url: string | null | undefined): url is string {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'));
}

export async function evaluateSpecialtyWithAI(req: Request, res: Response): Promise<void> {
  const providerSpecialtyId = String(req.params.id);
  const startTime = Date.now();

  try {
    const providerSpecialty = await prisma.providerSpecialty.findUnique({
      where: { id: providerSpecialtyId },
      include: {
        specialty: true,
        workSamples: {
          include: {
            proofs: true,
          },
        },
      },
    });

    if (!providerSpecialty) {
      res.status(404).json({ success: false, message: 'Provider specialty record not found in the database.' });
      return;
    }

    if (providerSpecialty.workSamples.length === 0) {
      res.status(400).json({ success: false, message: 'Cannot evaluate specialty without uploaded work samples.' });
      return;
    }

    await prisma.providerSpecialty.update({
      where: { id: providerSpecialtyId },
      data: { status: SpecialtyVerificationStatus.UNDER_AI_REVIEW },
    });

    const promptSections: string[] = [
      `--- PROVIDER SPECIALTY SUBMISSION ---
Specialty Category Name: ${providerSpecialty.specialty.name}
Claimed Sub-Specialties: ${providerSpecialty.subSpecialties.join(', ')}
Total Work Samples Uploaded: ${providerSpecialty.workSamples.length}`,
    ];

    // Best-effort image collection: an individual sample/proof whose image
    // fails to fetch (bad URL, unsupported type, too large, timeout, etc.)
    // is skipped with a server-side log — it does not fail the whole
    // evaluation, matching the original design's tolerance for missing
    // visuals (the text description alone still carries real signal).
    const images: GeminiImageInput[] = [];

    for (let i = 0; i < providerSpecialty.workSamples.length; i++) {
      const sample = providerSpecialty.workSamples[i];
      promptSections.push(`\n[Work Sample #${i + 1}]
Title: ${sample.title}
Description: ${truncate(sample.description)}
Technologies and tools: ${sample.technologies.length ? sample.technologies.join(', ') : 'Not specified'}
Public Asset: stored securely (${sample.mimeType}, ${sample.fileBytes} bytes, watermark: ${sample.watermarkLabel})
MimeType: ${sample.mimeType} (${sample.fileBytes} bytes)
Confidential Supporting Proof count: ${sample.proofs.length}`);

      if (images.length < MAX_VISION_IMAGES && sample.mimeType.startsWith('image/') && isFetchableImageUrl(sample.publicSampleUrl)) {
        try {
          const fetched = await fetchRemoteImage(sample.publicSampleUrl);
          images.push(fetched);
        } catch (imageError: any) {
          console.warn(`[SpecialtyAI] Skipping unfetchable work sample image (${sample.id}):`, imageError?.code || imageError?.message);
        }
      }

      for (let proofIndex = 0; proofIndex < sample.proofs.length; proofIndex++) {
        const proof = sample.proofs[proofIndex];
        promptSections.push(`  * Proof #${proofIndex + 1}: ${truncate(proof.fileName, 160)} (${proof.mimeType}, ${proof.fileBytes} bytes, confidential, watermark: ${proof.watermarkLabel})`);
        if (images.length < MAX_VISION_IMAGES && proof.mimeType.startsWith('image/') && isFetchableImageUrl(proof.fileUrl)) {
          try {
            const fetched = await fetchRemoteImage(proof.fileUrl);
            images.push(fetched);
          } catch (imageError: any) {
            console.warn(`[SpecialtyAI] Skipping unfetchable proof image (${proof.id}):`, imageError?.code || imageError?.message);
          }
        }
      }
    }

    const userPrompt = promptSections.join('\n');
    const attachedVisionImages = images.length;

    const geminiCall = attachedVisionImages > 0
      ? geminiClient.generateStructuredWithImage<AiSpecialtyEvaluationResult>(userPrompt, {
          systemInstruction: SPECIALTY_AUDIT_SYSTEM_PROMPT,
          responseSchema: SPECIALTY_EVALUATION_SCHEMA,
          validate: isValidSpecialtyEvaluation,
          temperature: 0.15,
          maxOutputTokens: 1500,
          images,
        })
      : geminiClient.generateStructured<AiSpecialtyEvaluationResult>(userPrompt, {
          systemInstruction: SPECIALTY_AUDIT_SYSTEM_PROMPT,
          responseSchema: SPECIALTY_EVALUATION_SCHEMA,
          validate: isValidSpecialtyEvaluation,
          temperature: 0.15,
          maxOutputTokens: 1500,
        });

    const result = await geminiCall;
    const evalResult = result.data;
    const latencyMs = Date.now() - startTime;

    const isAiScorePassed = evalResult.aiScore >= AI_SCORE_THRESHOLD;
    const isCredibilityPassed = evalResult.ownershipCredibility >= OWNERSHIP_CREDIBILITY_THRESHOLD;
    const finalApproved = isAiScorePassed && isCredibilityPassed;

    const targetStatus: SpecialtyVerificationStatus = finalApproved
      ? SpecialtyVerificationStatus.TEST_REQUIRED
      : SpecialtyVerificationStatus.REJECTED;

    // Only real usage numbers returned by GeminiClient after a genuine
    // provider success are ever persisted — 0 (the column's own default)
    // is used when the provider legitimately reports no usage metadata,
    // never a fabricated plausible-looking number.
    const promptTokens = result.usage.promptTokens ?? 0;
    const completionTokens = result.usage.completionTokens ?? 0;
    const totalTokens = result.usage.totalTokens ?? 0;

    const [updatedSpecialty, auditLog] = await prisma.$transaction([
      prisma.providerSpecialty.update({
        where: { id: providerSpecialtyId },
        data: {
          status: targetStatus,
          aiScore: parseFloat(evalResult.aiScore.toFixed(2)),
          feasibilityScore: parseFloat(evalResult.feasibilityScore.toFixed(2)),
          clarityScore: parseFloat(evalResult.clarityScore.toFixed(2)),
          ownershipCredibility: parseFloat(evalResult.ownershipCredibility.toFixed(2)),
          aiFeedback: {
            summary: evalResult.summary,
            strengths: evalResult.strengths || [],
            warnings: evalResult.warnings || [],
            corrections: evalResult.corrections || [],
          } as any,
        },
      }),
      prisma.aiAuditLog.create({
        data: {
          providerSpecialtyId,
          modelVersion: geminiModelConfig.visionModel,
          promptTokens,
          completionTokens,
          totalTokens,
          latencyMs,
          // Never duplicate image bytes into the audit log. Keep only bounded metadata.
          rawRequest: {
            specialtyId: providerSpecialty.specialtyId,
            workSamplesCount: providerSpecialty.workSamples.length,
            attachedVisionImages,
          } as any,
          rawResponse: { content: evalResult, usage: result.usage } as any,
          evaluationResult: finalApproved ? 'PASSED' : 'FAILED',
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        id: updatedSpecialty.id,
        status: updatedSpecialty.status,
        scores: {
          aiScore: updatedSpecialty.aiScore,
          feasibilityScore: updatedSpecialty.feasibilityScore,
          clarityScore: updatedSpecialty.clarityScore,
          ownershipCredibility: updatedSpecialty.ownershipCredibility,
        },
        feedback: updatedSpecialty.aiFeedback,
        audit: {
          logId: auditLog.id,
          tokensUsed: totalTokens,
          latencyMs,
        },
      },
    });
  } catch (error: any) {
    console.error('[SpecialtyAI Error] Exception during specialty evaluation:', error?.code || error);
    const latencyMs = Date.now() - startTime;

    // Honest failure — no fabricated scores, no fabricated token usage. The
    // specialty is rolled back to PENDING_PROOF (the pre-existing recovery
    // state) so the provider can retry once the AI service is available.
    try {
      await prisma.$transaction([
        prisma.providerSpecialty.update({
          where: { id: providerSpecialtyId },
          data: { status: SpecialtyVerificationStatus.PENDING_PROOF },
        }),
        prisma.aiAuditLog.create({
          data: {
            providerSpecialtyId,
            modelVersion: geminiModelConfig.visionModel,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            latencyMs,
            rawRequest: { error: 'Request terminated prematurely' } as any,
            rawResponse: {} as any,
            evaluationResult: 'SYSTEM_ERROR',
            errorMessage: error?.message || 'Unknown AI processing fault',
          },
        }),
      ]);
    } catch (dbError) {
      console.error('[SpecialtyAI Error] Failed to record rollback state:', dbError);
    }

    res.status(502).json({
      success: false,
      message: 'نعتذر، واجه نظام التدقيق الذكي ضغطاً مؤقتاً. تم إرجاع الحالة ويمكنك المحاولة مرة أخرى.',
      error: error?.message || 'Internal AI communication failure',
    });
  }
}
