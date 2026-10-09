import { Request, Response, NextFunction } from 'express';
import { WithdrawalStatus } from '@prisma/client';
import { createWithdrawalSchema, createMarketerWithdrawalSchema, rejectWithdrawalSchema, resolveWithdrawalSchema } from '../dtos/withdrawal.dto';
import { AppError } from '../utils/app-error';
import { withdrawalService, withoutLegacyWithdrawalBankFields } from '../services/withdrawal.service';
import { payoutService } from '../services/payout.service';
import { isPayoutAutomationEnabled } from '../utils/payout-automation.util';

const adminId = (req: Request) => req.user!.id;
const userId = (req: Request) => req.user!.userId || req.user!.id;

export async function submitWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createWithdrawalSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    const data = await withdrawalService.createForProvider(userId(req), parsed.data);
    res.status(201).json({ success: true, message: 'تم تقديم طلب السحب بنجاح', data });
  } catch (error) { next(error); }
}

export async function submitMarketerWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createMarketerWithdrawalSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    const data = await withdrawalService.createForMarketer(userId(req), parsed.data);
    res.status(201).json({ success: true, message: 'تم تقديم طلب السحب بنجاح', data });
  } catch (error) { next(error); }
}

export async function listMyWithdrawals(req: Request, res: Response, next: NextFunction) {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(WithdrawalStatus).includes(rawStatus as WithdrawalStatus) ? rawStatus as WithdrawalStatus : undefined;
    if (rawStatus && !status) throw new AppError('حالة طلب السحب غير صحيحة', 400);
    const data = await withdrawalService.listForMarketer(userId(req), status, Number(req.query.page) || 1, Number(req.query.limit) || 10); // PayPal only: no legacy bank fields
    res.json({ success: true, message: 'تم جلب سجل السحب بنجاح', data });
  } catch (error) { next(error); }
}

// Marketer's own history: same as listMyWithdrawals but PayPal only (no legacy bank fields in the response).
export async function listMyMarketerWithdrawals(req: Request, res: Response, next: NextFunction) {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(WithdrawalStatus).includes(rawStatus as WithdrawalStatus) ? rawStatus as WithdrawalStatus : undefined;
    if (rawStatus && !status) throw new AppError('حالة طلب السحب غير صحيحة', 400);
    const data = await withdrawalService.listForMarketer(userId(req), status, Number(req.query.page) || 1, Number(req.query.limit) || 10);
    res.json({ success: true, message: 'تم جلب سجل السحب بنجاح', data });
  } catch (error) { next(error); }
}

export async function listWithdrawals(req: Request, res: Response, next: NextFunction) {
  try { const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined; const status = rawStatus && Object.values(WithdrawalStatus).includes(rawStatus as WithdrawalStatus) ? rawStatus as WithdrawalStatus : undefined; if (rawStatus && !status) throw new AppError('حالة طلب السحب غير صحيحة', 400); res.json({ success: true, data: await withdrawalService.list(status, Number(req.query.page) || 1, Number(req.query.limit) || 20) }); } catch (error) { next(error); }
}

export async function getWithdrawal(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await withdrawalService.get(String(req.params.id)) }); } catch (error) { next(error); }
}

export async function approveWithdrawal(req: Request, res: Response, next: NextFunction) {
  try { const parsed = resolveWithdrawalSchema.safeParse(req.body || {}); if (!parsed.success) throw new AppError('بيانات اعتماد السحب غير صحيحة', 400); res.json({ success: true, data: withoutLegacyWithdrawalBankFields(await withdrawalService.approve(String(req.params.id), adminId(req), parsed.data)) }); } catch (error) { next(error); }
}

export async function rejectWithdrawal(req: Request, res: Response, next: NextFunction) {
  try { const parsed = rejectWithdrawalSchema.safeParse(req.body); if (!parsed.success) throw new AppError('سبب رفض السحب مطلوب', 400); res.json({ success: true, data: withoutLegacyWithdrawalBankFields(await withdrawalService.reject(String(req.params.id), adminId(req), parsed.data)) }); } catch (error) { next(error); }
}

// Payout P2-C: deliberately takes NO request body at all — every financial
// field (amount, recipient, senderBatchId, senderItemId) is sourced
// exclusively from trusted DB state inside payoutService.sendPayout(),
// never from anything a caller could submit. The only input is the
// withdrawal id in the URL, exactly like approve()/reject() above.
export async function sendWithdrawalPayout(req: Request, res: Response, next: NextFunction) {
  // Payout P3-D is excluded from this release — its tables have no migration
  // yet (see utils/payout-automation.util.ts). Gate before calling
  // payoutService.sendPayout(), which would otherwise hit a missing table.
  if (!isPayoutAutomationEnabled()) {
    return res.status(503).json({ success: false, message: 'إرسال التحويل الآلي عبر PayPal غير متاح حاليًا في هذا الإصدار' });
  }
  try { res.json({ success: true, data: await payoutService.sendPayout(String(req.params.id)) }); } catch (error) { next(error); }
}
