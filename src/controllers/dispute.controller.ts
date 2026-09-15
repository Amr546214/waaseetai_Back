import { Request, Response, NextFunction } from 'express';
import { DisputeStatus } from '@prisma/client';
import { disputeService } from '../services/dispute.service';
import { createDisputeSchema, resolveDisputeSchema } from '../dtos/dispute.dto';
import { AppError } from '../utils/app-error';

const actorId = (req: Request) => req.user?.id || req.user?.userId!;

export async function listDisputes(req: Request, res: Response, next: NextFunction) {
  try { const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined; const status = rawStatus && Object.values(DisputeStatus).includes(rawStatus as DisputeStatus) ? rawStatus as DisputeStatus : undefined; if (rawStatus && !status) throw new AppError('حالة النزاع غير صحيحة', 400); const data = await disputeService.listForAdmin(status, Number(req.query.page) || 1, Number(req.query.limit) || 20); res.json({ success: true, data }); } catch (error) { next(error); }
}

export async function getDispute(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await disputeService.getForAdmin(String(req.params.id)) }); } catch (error) { next(error); }
}

export async function resolveDispute(req: Request, res: Response, next: NextFunction) {
  try { const parsed = resolveDisputeSchema.safeParse(req.body); if (!parsed.success) throw new AppError('بيانات حل النزاع غير صحيحة', 400); res.json({ success: true, data: await disputeService.resolve(String(req.params.id), actorId(req), parsed.data) }); } catch (error) { next(error); }
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
