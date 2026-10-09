import { Request, Response } from 'express';
import { AppError } from '../utils/app-error';
import { aiAssessmentService, assessmentResultMessage, ASSESSMENT_GENERATION_FAILED_CODE, ASSESSMENT_GRADING_FAILED_CODE } from '../services/ai-assessment.service';

/**
 * POST /api/assessments/generate
 */
export async function generateAssessmentController(req: Request, res: Response): Promise<void> {
  try {
    const providerSpecialtyId = req.body.providerSpecialtyId || req.body.specialtyId || req.params.providerSpecialtyId;
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({ success: false, message: 'غير مصرح لك بالوصول.' });
      return;
    }

    if (!providerSpecialtyId) {
      res.status(400).json({
        success: false,
        message: 'providerSpecialtyId is required to generate assessment.'
      });
      return;
    }

    const result = await aiAssessmentService.generateAssessment(String(providerSpecialtyId), userId);

    const message = 'تم توليد أسئلة التقييم الفني بنجاح عبر خدمة الذكاء الاصطناعي.';

    res.status(201).json({
      success: true,
      message,
      data: result
    });
  } catch (error: any) {
    // coded business refusals (404 not found / 409 not eligible or in progress / 429 cooldown or attempt limit) are never a 500
    const businessStatus: number | undefined = error instanceof AppError ? error.statusCode : (typeof error?.statusCode === 'number' ? error.statusCode : (error?.code === 'GENERATION_IN_PROGRESS' ? 409 : undefined));
    if (businessStatus && businessStatus < 500) {
      res.status(businessStatus).json({ success: false, ...(error?.code ? { code: error.code } : {}), ...(typeof error?.retryAfterSeconds === 'number' ? { retryAfterSeconds: error.retryAfterSeconds } : {}), message: error.message });
      return;
    }
    console.error('[AiAssessmentController] generate error:', error);
    res.status(error?.code === ASSESSMENT_GENERATION_FAILED_CODE ? 503 : 500).json({
      success: false,
      // `code` is only ever a fixed, hardcoded marker this codebase sets
      // itself (e.g. GENERATION_IN_PROGRESS) — never a raw provider
      // error — so it is safe to forward as-is (Batch 3D-2).
      ...(error?.code ? { code: error.code } : {}),
      message: error?.message || 'حدث خطأ أثناء توليد أسئلة التقييم الفني.'
    });
  }
}

/**
 * POST /api/assessments/:attemptId/submit
 */
export async function submitAssessmentController(req: Request, res: Response): Promise<void> {
  try {
    const attemptId = req.params.attemptId || req.body.attemptId;
    const submittedAnswers = req.body.submittedAnswers || req.body.answers || {};

    if (!attemptId) {
      res.status(400).json({
        success: false,
        message: 'attemptId parameter is required.'
      });
      return;
    }

    const result = await aiAssessmentService.submitAssessment(String(attemptId), submittedAnswers, req.user?.id);

    res.status(200).json({
      success: true,
      message: assessmentResultMessage(result),
      data: result
    });
  } catch (error: any) {
    if (error instanceof AppError && error.statusCode < 500) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    console.error('[AiAssessmentController] submit error:', error);
    res.status(error?.code === ASSESSMENT_GRADING_FAILED_CODE ? 503 : 500).json({
      success: false,
      ...(error?.code === ASSESSMENT_GRADING_FAILED_CODE ? { code: error.code } : {}),
      message: error?.message || 'حدث خطأ أثناء معالجة وتسليم نتائج التقييم.'
    });
  }
}

/**
 * GET /api/assessments/:attemptId/status
 */
export async function getAttemptStatusController(req: Request, res: Response): Promise<void> {
  try {
    const attemptId = req.params.attemptId;
    if (!attemptId) {
      res.status(400).json({ success: false, message: 'attemptId parameter is required.' });
      return;
    }

    const result = await aiAssessmentService.getAttemptStatus(String(attemptId), req.user?.id);
    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    console.error('[AiAssessmentController] status error:', error);
    res.status(500).json({
      success: false,
      message: error?.message || 'حدث خطأ أثناء جلب حالة المحاولة.'
    });
  }
}
