import { randomUUID } from 'crypto';
import { SupportTicketStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateSupportTicketInput } from '../dtos/support-ticket.dto';

const OPEN_STATUSES: SupportTicketStatus[] = [
  SupportTicketStatus.OPEN,
  SupportTicketStatus.IN_PROGRESS,
  SupportTicketStatus.AWAITING_CUSTOMER,
];

function generateTicketNumber(): string {
  // Not sequential (no real ticket-numbering counter exists yet) — just a
  // short, unique, human-shareable reference. Good enough to identify a
  // ticket in conversation; a display-only detail, not a business invariant.
  return `TK-${randomUUID().split('-')[0].toUpperCase()}`;
}

export class SupportTicketService {
  async create(userId: string, input: CreateSupportTicketInput) {
    const ticket = await prisma.supportTicket.create({
      data: {
        ticketNumber: generateTicketNumber(),
        userId,
        subject: input.subject,
        category: input.category,
        priority: input.priority || 'عادية',
        description: input.description,
        relatedOrder: input.relatedOrder || null,
        relatedProject: input.relatedProject || null,
        relatedMember: input.relatedMember || null,
        ccEmail: input.ccEmail || null,
        status: SupportTicketStatus.OPEN,
      },
    });
    // Seed the reply thread with the ticket owner's own original message,
    // so the detail page's thread always starts from something real.
    await prisma.supportTicketMessage.create({
      data: { ticketId: ticket.id, senderId: userId, body: input.description },
    });
    return ticket;
  }

  async listForUser(userId: string, status?: SupportTicketStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where = { userId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit,
      }),
      prisma.supportTicket.count({ where }),
    ]);
    return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
  }

  private async findOwned(id: string, userId: string) {
    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new AppError('التذكرة غير موجودة', 404);
    if (ticket.userId !== userId) throw new AppError('لا تملك صلاحية الوصول لهذه التذكرة', 403);
    return ticket;
  }

  async getForUser(id: string, userId: string) {
    const ticket = await this.findOwned(id, userId);
    const messages = await prisma.supportTicketMessage.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return { ticket, messages };
  }

  async reply(id: string, userId: string, body: string) {
    const ticket = await this.findOwned(id, userId);
    if (!OPEN_STATUSES.includes(ticket.status) && ticket.status !== SupportTicketStatus.RESOLVED) {
      throw new AppError('لا يمكن الرد على تذكرة مغلقة', 400);
    }
    const message = await prisma.supportTicketMessage.create({
      data: { ticketId: ticket.id, senderId: userId, body },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    // A reply from the ticket owner on an already-resolved ticket reopens it
    // — a real support-desk convention, and the only status transition the
    // ticket owner (as opposed to a future staff/admin workflow) can trigger.
    if (ticket.status === SupportTicketStatus.RESOLVED) {
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: SupportTicketStatus.OPEN, resolvedAt: null } });
    }
    return message;
  }

  async close(id: string, userId: string) {
    const ticket = await this.findOwned(id, userId);
    if (ticket.status === SupportTicketStatus.CLOSED) throw new AppError('التذكرة مغلقة مسبقًا', 409);
    return prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: SupportTicketStatus.CLOSED, closedAt: new Date() },
    });
  }
}

export const supportTicketService = new SupportTicketService();
