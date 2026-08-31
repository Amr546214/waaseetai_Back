import { Request, Response } from 'express';
import { aiAssessmentService } from '../services/ai-assessment.service';

/**
 * POST /api/assessments/generate
 */
export async function generateAssessmentController(req: Request, res: Response): Promise<void> {
  try {
    const providerSpecialtyId = req.body.providerSpecialtyId || req.body.specialtyId || req.params.providerSpecialtyId;
    const userId = (req as any).user?.id;

    if (!providerSpecialtyId) {
      res.status(400).json({
        success: false,
        message: 'providerSpecialtyId is required to generate assessment.'
      });
      return;
    }

    const result = await aiAssessmentService.generateAssessment(String(providerSpecialtyId), userId);

    res.status(201).json({
      success: true,
      message: 'تم توليد أسئلة التقييم الفني بنجاح عبر محرك OpenAI.',
      data: result
    });
  } catch (error: any) {
    console.error('[AiAssessmentController] generate error:', error);
    res.status(500).json({
      success: false,
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

    const result = await aiAssessmentService.submitAssessment(String(attemptId), submittedAnswers);

    res.status(200).json({
      success: true,
      message: result.isPassed
        ? '✓ مبروك! لقد اجتزت التقييم الفني بنجاح وتم اعتماد التخصص!'
        : 'لم تتجاوز نسبة الاجتياز المطلوبة (25%). يُمكنك المراجعة وإعادة المحاولة.',
      data: result
    });
  } catch (error: any) {
    console.error('[AiAssessmentController] submit error:', error);
    res.status(500).json({
      success: false,
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

    const result = await aiAssessmentService.getAttemptStatus(String(attemptId));
    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[AiAssessmentController] status error:', error);
    res.status(500).json({
      success: false,
      message: error?.message || 'حدث خطأ أثناء جلب حالة المحاولة.'
    });
  }
}
