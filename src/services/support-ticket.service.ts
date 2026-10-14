import { randomUUID } from 'crypto';
import { AccountType, SupportTicketStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';
import { CreateSupportTicketInput } from '../dtos/support-ticket.dto';
import { adminAudit } from './admin-audit.service';

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

const SENDER_SELECT = { id: true, firstName: true, lastName: true, accountType: true } as const;

const STATUS_LABELS_AR: Record<SupportTicketStatus, string> = {
  OPEN: 'مفتوحة',
  IN_PROGRESS: 'قيد المراجعة',
  AWAITING_CUSTOMER: 'بانتظار ردّك',
  RESOLVED: 'محلولة',
  CLOSED: 'مغلقة',
};

// Where the ticket owner reads the ticket, by their account type.
function ticketActionUrl(accountType: string | undefined, ticketId: string): string | undefined {
  if (accountType?.startsWith('PROVIDER')) return `/provider-overview/help/tickets/${ticketId}`;
  if (accountType?.startsWith('CLIENT')) return `/client-overview/help/tickets/${ticketId}`;
  // The marketer help page is the single destination of the marketer router (its ticket thread lives there).
  if (accountType === 'MARKETING_BROKER') return '/marketer-overview/help';
  return undefined;
}

export class SupportTicketService {
  // Ticket notifications go through createAndEmit so the owner's merged
  // channel preferences apply. A failed notification never fails the ticket
  // action itself (the reply/status change is already saved).
  private async notifyOwner(ticket: { id: string; userId: string; ticketNumber: string }, title: string, message: string, event: string) {
    try {
      const owner = await prisma.user.findUnique({ where: { id: ticket.userId }, select: { accountType: true } });
      await notificationService.createAndEmit({
        userId: ticket.userId,
        title,
        message,
        type: 'SUPPORT_TICKET',
        actionUrl: ticketActionUrl(owner?.accountType, ticket.id),
        actionText: 'عرض التذكرة',
        metadata: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, event },
      });
    } catch (err) {
      console.error('[support-ticket] notification failed', err);
    }
  }

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
    await this.notifyOwner(ticket, 'تم استلام تذكرتك', `فُتحت التذكرة ${ticket.ticketNumber}. سنُبلغك هنا عند ردّ فريق الدعم.`, 'created');
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
    // Someone else's ticket answers exactly like a missing one (404): the ids of other users' tickets cannot be probed.
    if (!ticket || ticket.userId !== userId) throw new AppError('التذكرة غير موجودة', 404);
    return ticket;
  }

  async getForUser(id: string, userId: string) {
    const ticket = await this.findOwned(id, userId);
    const messages = await prisma.supportTicketMessage.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: SENDER_SELECT } },
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
      include: { sender: { select: SENDER_SELECT } },
    });
    // Owner replies drive the status: RESOLVED reopens (OPEN), and a reply to
    // a staff question (AWAITING_CUSTOMER) hands the ball back to staff
    // (IN_PROGRESS, since staff already engaged with it).
    if (ticket.status === SupportTicketStatus.RESOLVED) {
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: SupportTicketStatus.OPEN, resolvedAt: null } });
    } else if (ticket.status === SupportTicketStatus.AWAITING_CUSTOMER) {
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: SupportTicketStatus.IN_PROGRESS } });
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
  // ─── Staff / admin (ADMIN, SUPER_ADMIN — enforced by the route guard) ───────

  async listForAdmin(filters: { status?: SupportTicketStatus; q?: string; userId?: string }, page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const q = filters.q?.trim();
    const where = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(q ? { OR: [
        { ticketNumber: { contains: q, mode: 'insensitive' as const } },
        { subject: { contains: q, mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [items, total, grouped] = await Promise.all([
      prisma.supportTicket.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit,
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true, accountType: true } } },
      }),
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const assignees = await this.assigneesFor(items.map(i => i.id));
    const pages = Math.ceil(total / safeLimit);
    return { items: items.map(i => ({ ...i, assignedTo: assignees.get(i.id) ?? null })), counts, pagination: { page: safePage, limit: safeLimit, total, pages, totalPages: pages } };
  }

  private async findAny(id: string) {
    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new AppError('التذكرة غير موجودة', 404);
    return ticket;
  }

  /** Current assignee per ticket = the newest TICKET_ASSIGNED audit row (the schema has no assignee column). */
  private async assigneesFor(ids: string[]) {
    const result = new Map<string, { id: string; name: string }>();
    if (!ids.length) return result;
    const rows = await prisma.accountAuditLog.findMany({
      where: { source: 'ADMIN', eventType: 'TICKET_ASSIGNED', OR: ids.map(id => ({ context: { path: ['entityId'], equals: id } })) },
      orderBy: { occurredAt: 'desc' },
      select: { context: true }
    });
    for (const row of rows) {
      const ctx = (row.context ?? {}) as Record<string, any>;
      if (ctx.entityId && !result.has(ctx.entityId) && ctx.assigneeId) result.set(ctx.entityId, { id: ctx.assigneeId, name: ctx.assigneeName ?? '' });
    }
    return result;
  }

  async getForAdmin(id: string) {
    const ticket = await this.findAny(id);
    const [messages, user, audit] = await Promise.all([
      prisma.supportTicketMessage.findMany({
        where: { ticketId: ticket.id },
        orderBy: { createdAt: 'asc' },
        include: { sender: { select: SENDER_SELECT } },
      }),
      prisma.user.findUnique({
        where: { id: ticket.userId },
        select: { id: true, firstName: true, lastName: true, email: true, accountType: true },
      }),
      adminAudit.listForEntity('TICKET', ticket.id),
    ]);
    const assignment = audit.find(e => e.eventType === 'TICKET_ASSIGNED');
    // Internal notes live ONLY in the admin audit store, never in support_ticket_messages, so the owner's thread (getForUser) cannot contain them.
    const internalNotes = audit.filter(e => e.eventType === 'TICKET_INTERNAL_NOTE').map(e => ({ id: e.id, body: String(e.context.body ?? ''), createdAt: e.occurredAt, admin: e.admin }));
    return { ticket, user, messages, assignedTo: assignment ? { id: assignment.context.assigneeId, name: assignment.context.assigneeName ?? '' } : null, internalNotes };
  }

  async assign(id: string, adminId: string, assigneeId: string) {
    const ticket = await this.findAny(id);
    const assignee = await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true, firstName: true, lastName: true, accountType: true } });
    if (!assignee || (assignee.accountType !== AccountType.ADMIN && assignee.accountType !== AccountType.SUPER_ADMIN)) throw new AppError('يمكن تكليف مشرف أو مدير فقط', 400);
    const name = [assignee.firstName, assignee.lastName].filter(Boolean).join(' ');
    await adminAudit.record({ adminId, entity: 'TICKET', entityId: ticket.id, eventType: 'TICKET_ASSIGNED', title: 'تكليف تذكرة', summary: `تكليف التذكرة ${ticket.ticketNumber} إلى ${name || 'مشرف'}`, details: { assigneeId: assignee.id, assigneeName: name } });
    return { id: ticket.id, assignedTo: { id: assignee.id, name } };
  }

  async setPriority(id: string, adminId: string, priority: string) {
    const ticket = await this.findAny(id);
    if (ticket.priority === priority) throw new AppError('التذكرة بهذه الأولوية مسبقًا', 409);
    const updated = await prisma.supportTicket.update({ where: { id: ticket.id }, data: { priority } });
    await adminAudit.record({ adminId, entity: 'TICKET', entityId: ticket.id, eventType: 'TICKET_PRIORITY_CHANGED', title: 'تغيير أولوية تذكرة', summary: `تغيير أولوية التذكرة ${ticket.ticketNumber}`, before: { priority: ticket.priority }, after: { priority } });
    return updated;
  }

  async addInternalNote(id: string, adminId: string, body: string) {
    const ticket = await this.findAny(id);
    const row = await adminAudit.record({ adminId, entity: 'TICKET', entityId: ticket.id, eventType: 'TICKET_INTERNAL_NOTE', title: 'ملاحظة داخلية على تذكرة', summary: `إضافة ملاحظة داخلية على التذكرة ${ticket.ticketNumber}`, details: { body } });
    if (!row) throw new AppError('تعذر حفظ الملاحظة، حاول مرة أخرى', 500);
    return { id: row.id, body, createdAt: row.occurredAt };
  }

  // Staff reply. Unless the caller picks a status explicitly, a reply on an
  // OPEN/IN_PROGRESS ticket moves it to AWAITING_CUSTOMER (the ball is with
  // the owner now); any other status is left as-is. CLOSED tickets can't be
  // replied to — reopen them via setStatus first.
  async replyAsStaff(id: string, staffId: string, body: string, status?: SupportTicketStatus) {
    const ticket = await this.findAny(id);
    if (ticket.status === SupportTicketStatus.CLOSED) throw new AppError('لا يمكن الرد على تذكرة مغلقة', 400);
    const message = await prisma.supportTicketMessage.create({
      data: { ticketId: ticket.id, senderId: staffId, body },
      include: { sender: { select: SENDER_SELECT } },
    });
    const next = status
      ?? (ticket.status === SupportTicketStatus.OPEN || ticket.status === SupportTicketStatus.IN_PROGRESS
        ? SupportTicketStatus.AWAITING_CUSTOMER : ticket.status);
    if (next !== ticket.status) {
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: this.statusData(next) });
    } else {
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    }
    await adminAudit.record({ adminId: staffId, entity: 'TICKET', entityId: ticket.id, eventType: 'TICKET_REPLIED', title: 'ردّ على تذكرة', summary: `ردّ فريق الدعم على التذكرة ${ticket.ticketNumber}`, after: { status: next } });
    await this.notifyOwner(ticket, 'ردّ جديد على تذكرتك', `ردّ فريق الدعم على التذكرة ${ticket.ticketNumber}.`, 'replied');
    return { message, status: next };
  }

  private statusData(status: SupportTicketStatus) {
    return {
      status,
      resolvedAt: status === SupportTicketStatus.RESOLVED ? new Date() : null,
      closedAt: status === SupportTicketStatus.CLOSED ? new Date() : null,
    };
  }

  async setStatus(id: string, status: SupportTicketStatus, adminId?: string) {
    const ticket = await this.findAny(id);
    if (ticket.status === status) throw new AppError('التذكرة بهذه الحالة مسبقًا', 409);
    const updated = await prisma.supportTicket.update({ where: { id: ticket.id }, data: this.statusData(status) });
    if (adminId) await adminAudit.record({ adminId, entity: 'TICKET', entityId: ticket.id, eventType: 'TICKET_STATUS_CHANGED', title: 'تغيير حالة تذكرة', summary: `تغيير حالة التذكرة ${ticket.ticketNumber}`, before: { status: ticket.status }, after: { status } });
    await this.notifyOwner(ticket, 'تحديث حالة تذكرتك', `أصبحت حالة التذكرة ${ticket.ticketNumber}: ${STATUS_LABELS_AR[status]}.`, 'status_changed');
    return updated;
  }
}

export const supportTicketService = new SupportTicketService();
