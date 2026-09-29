import { Request, Response, NextFunction } from 'express';
import { SupportTicketStatus } from '@prisma/client';
import { createSupportTicketSchema, replyToTicketSchema } from '../dtos/support-ticket.dto';
import { supportTicketService } from '../services/support-ticket.service';
import { AppError } from '../utils/app-error';

const userId = (req: Request) => req.user!.userId || req.user!.id;

export async function createTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    const data = await supportTicketService.create(userId(req), parsed.data);
    res.status(201).json({ success: true, message: 'تم فتح تذكرتك بنجاح', data });
  } catch (error) { next(error); }
}

export async function listMyTickets(req: Request, res: Response, next: NextFunction) {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(SupportTicketStatus).includes(rawStatus as SupportTicketStatus) ? rawStatus as SupportTicketStatus : undefined;
    if (rawStatus && !status) throw new AppError('حالة التذكرة غير صحيحة', 400);
    const data = await supportTicketService.listForUser(userId(req), status, Number(req.query.page) || 1, Number(req.query.limit) || 20);
    res.json({ success: true, data });
  } catch (error) { next(error); }
}

export async function getMyTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await supportTicketService.getForUser(String(req.params.id), userId(req));
    res.json({ success: true, data });
  } catch (error) { next(error); }
}

export async function replyToTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = replyToTicketSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    const data = await supportTicketService.reply(String(req.params.id), userId(req), parsed.data.body);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
}

export async function closeMyTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await supportTicketService.close(String(req.params.id), userId(req));
    res.json({ success: true, message: 'أُغلقت التذكرة', data });
  } catch (error) { next(error); }
}
