import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error';
import { disputeSummaryService } from '../services/ai-features/dispute-summary.service';
import {
  listDisputes as baseListDisputes,
  getDispute as baseGetDispute,
  resolveDispute as baseResolveDispute
} from './dispute.controller';

export const listDisputes = baseListDisputes;
export const getDispute = baseGetDispute;
export const resolveDispute = baseResolveDispute;

/**
 * Advisory-only AI summary for dispute mediation.
 * Calls Waseet AI dispute-summary service.
 */
export async function getDisputeAiSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const disputeId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!disputeId) return next(new AppError('معرف النزاع مطلوب', 400));
    const data = await disputeSummaryService.generateSummary(disputeId);
    res.json({ success: true, data });
  } catch (error: any) {
    if (error instanceof AppError) return next(error);
    console.error('[AdminDisputesController] Dispute AI summary unavailable');
    res.status(502).json({
      success: false,
      message: 'تعذر إنشاء ملخص الذكاء الاصطناعي لهذا النزاع حالياً. يمكنك متابعة المراجعة واتخاذ القرار يدوياً كالمعتاد.',
    });
  }
}
