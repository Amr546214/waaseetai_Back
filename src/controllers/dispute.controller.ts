import { Request, Response, NextFunction } from 'express';
import { DisputeStatus } from '@prisma/client';
import { disputeService } from '../services/dispute.service';
import { assignDisputeSchema, createDisputeSchema, disputeNoteSchema, disputeStatusSchema, resolveDisputeFinancialSchema, resolveDisputeSchema } from '../dtos/dispute.dto';
import { AppError } from '../utils/app-error';

const actorId = (req: Request) => req.user?.id || req.user?.userId!;

export async function listDisputes(req: Request, res: Response, next: NextFunction) {
  try { const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined; const status = rawStatus && Object.values(DisputeStatus).includes(rawStatus as DisputeStatus) ? rawStatus as DisputeStatus : undefined; if (rawStatus && !status) throw new AppError('حالة النزاع غير صحيحة', 400); const data = await disputeService.listForAdmin(status, Number(req.query.page) || 1, Number(req.query.limit) || 20); res.json({ success: true, data }); } catch (error) { next(error); }
}

export async function listMyDisputes(req: Request, res: Response, next: NextFunction) {
  try { const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined; const status = rawStatus && Object.values(DisputeStatus).includes(rawStatus as DisputeStatus) ? rawStatus as DisputeStatus : undefined; if (rawStatus && !status) throw new AppError('حالة النزاع غير صحيحة', 400); const data = await disputeService.listForUser(actorId(req), status, Number(req.query.page) || 1, Number(req.query.limit) || 20); res.json({ success: true, data }); } catch (error) { next(error); }
}

export async function getMyDispute(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await disputeService.getForUser(String(req.params.id), actorId(req)) }); } catch (error) { next(error); }
}

export async function getDispute(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await disputeService.getForAdmin(String(req.params.id)) }); } catch (error) { next(error); }
}

export async function resolveDispute(req: Request, res: Response, next: NextFunction) {
  try { const parsed = resolveDisputeSchema.safeParse(req.body); if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'بيانات حل النزاع غير صحيحة', 400, parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))); res.json({ success: true, data: await disputeService.resolve(String(req.params.id), actorId(req), parsed.data) }); } catch (error) { next(error); }
}

// Financial resolution: the only dispute endpoint that moves money. Explicit amounts + `confirm: true`; see docs/proposals/dispute-freeze-and-resolution.md.
export async function resolveDisputeFinancial(req: Request, res: Response, next: NextFunction) {
  try { const parsed = resolveDisputeFinancialSchema.safeParse(req.body); if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'بيانات القرار المالي غير صحيحة', 400, parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))); res.json({ success: true, data: await disputeService.resolveFinancial(String(req.params.id), actorId(req), parsed.data) }); } catch (error) { next(error); }
}

// Advisory-only — never resolves/rejects the dispute, never touches status
// or money. On any WaseetAI failure this returns an honest 502, not a
// fabricated summary; the manual resolve/reject workflow above is
// completely unaffected either way.
export async function getDisputeAiSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await disputeService.generateAiSummary(String(req.params.id));
    res.json({ success: true, data });
  } catch (error: any) {
    if (error instanceof AppError) return next(error);
    console.error('[DisputeAiSummary] Failed:', error?.code || error?.message);
    res.status(502).json({
      success: false,
      message: 'تعذر إنشاء ملخص الذكاء الاصطناعي لهذا النزاع حالياً. يمكنك متابعة المراجعة واتخاذ القرار يدوياً كالمعتاد.',
    });
  }
}

export async function openClientDispute(req: Request, res: Response, next: NextFunction) {
  try { const parsed = createDisputeSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات النزاع غير صحيحة', 400); res.status(201).json({ success: true, data: await disputeService.createForRequest(String(req.params.id), actorId(req), 'client', parsed.data) }); } catch (error) { next(error); }
}

export async function openProviderDispute(req: Request, res: Response, next: NextFunction) {
  try { const parsed = createDisputeSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات النزاع غير صحيحة', 400); res.status(201).json({ success: true, data: await disputeService.createForRequest(String(req.params.id), actorId(req), 'provider', parsed.data) }); } catch (error) { next(error); }
}

export async function cancelProviderRequest(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await disputeService.cancelByProvider(String(req.params.id), actorId(req)) }); } catch (error) { next(error); }
}

export async function assignAdminDispute(req: Request, res: Response, next: NextFunction) {
  try { const parsed = assignDisputeSchema.safeParse(req.body); if (!parsed.success) throw new AppError('حدد المشرف المسؤول عن النزاع', 400); res.json({ success: true, data: await disputeService.assign(String(req.params.id), actorId(req), parsed.data.assigneeId) }); } catch (error) { next(error); }
}

export async function addAdminDisputeNote(req: Request, res: Response, next: NextFunction) {
  try { const parsed = disputeNoteSchema.safeParse(req.body); if (!parsed.success) throw new AppError('أدخل نص الملاحظة', 400); res.status(201).json({ success: true, data: await disputeService.addNote(String(req.params.id), actorId(req), parsed.data.body) }); } catch (error) { next(error); }
}

export async function setAdminDisputeStatus(req: Request, res: Response, next: NextFunction) {
  try { const parsed = disputeStatusSchema.safeParse(req.body); if (!parsed.success) throw new AppError('حالة النزاع غير صحيحة', 400); res.json({ success: true, data: await disputeService.setStatus(String(req.params.id), actorId(req), parsed.data.status) }); } catch (error) { next(error); }
}
