import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { accountAuditLogService, AuditContext } from './account-logs.service';
import { sessionService } from './session.service';

const ADMIN_TYPES = ['ADMIN', 'SUPER_ADMIN'] as const;

export const updateAdminProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  phoneCountryCode: z.string().trim().regex(/^\+\d{1,4}$/).optional(),
  phoneNumber: z.string().trim().regex(/^\d{6,15}$/).nullable().optional()
}).strict();

export interface AuditLogQuery {
  page?: unknown; limit?: unknown; q?: string; eventType?: string; severity?: string; source?: string;
  actorId?: string; from?: string; to?: string; scope?: string;
}

const boundedInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const code = (v: string) => String(v).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);

class AdminAccountService {
  /**
   * Real AccountAuditLog rows. Default scope "admin" = events about an ADMIN/SUPER_ADMIN account or performed by an admin (source ADMIN);
   * scope "all" = the whole platform. Filters: actor (the account the entry belongs to), event type, severity, source, date range, text, page.
   */
  async listAuditLog(query: AuditLogQuery) {
    const page = boundedInt(query.page, 1, 1, 100000);
    const limit = boundedInt(query.limit, 20, 1, 100);
    const and: Prisma.AccountAuditLogWhereInput[] = [];
    if (query.scope !== 'all') and.push({ OR: [{ user: { accountType: { in: [...ADMIN_TYPES] } } }, { source: 'ADMIN' }] });
    if (query.actorId) and.push({ userId: String(query.actorId) });
    if (query.eventType) and.push({ eventType: code(query.eventType) });
    if (query.severity && ['INFO', 'WARNING', 'CRITICAL'].includes(query.severity)) and.push({ severity: query.severity });
    if (query.source && ['USER', 'AI', 'ADMIN', 'SYSTEM'].includes(query.source)) and.push({ source: query.source });
    if (query.q) {
      const q = String(query.q).trim().slice(0, 80);
      if (q) and.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { summary: { contains: q, mode: 'insensitive' } }, { eventType: { contains: q, mode: 'insensitive' } }, { actorLabel: { contains: q, mode: 'insensitive' } }] });
    }
    const occurredAt: Prisma.DateTimeFilter = {};
    if (query.from && !Number.isNaN(Date.parse(query.from))) occurredAt.gte = new Date(query.from);
    if (query.to && !Number.isNaN(Date.parse(query.to))) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); occurredAt.lte = end; }
    if (occurredAt.gte || occurredAt.lte) and.push({ occurredAt });
    const where: Prisma.AccountAuditLogWhereInput = and.length ? { AND: and } : {};

    const [rows, total, kinds] = await Promise.all([
      prisma.accountAuditLog.findMany({
        where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, eventType: true, category: true, title: true, summary: true, actionText: true, severity: true, source: true, status: true, occurredAt: true, ipAddress: true, device: true, actorLabel: true, userId: true, user: { select: { firstName: true, lastName: true, accountType: true } } }
      }),
      prisma.accountAuditLog.count({ where }),
      prisma.accountAuditLog.groupBy({ by: ['eventType'], where: query.scope !== 'all' ? { OR: [{ user: { accountType: { in: [...ADMIN_TYPES] } } }, { source: 'ADMIN' }] } : {}, _count: { _all: true } })
    ]);
    return {
      items: rows.map((r: any) => ({
        id: r.id, eventType: r.eventType || 'SYSTEM_EVENT', category: r.category, title: r.title, summary: r.summary || r.actionText,
        severity: r.severity || 'INFO', source: r.source || 'SYSTEM', status: r.status, occurredAt: r.occurredAt,
        ipAddress: r.ipAddress, device: r.device, actorLabel: r.actorLabel,
        account: { id: r.userId, name: `${r.user?.firstName ?? ''} ${r.user?.lastName ?? ''}`.trim(), accountType: r.user?.accountType ?? null }
      })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      eventTypes: kinds.map((k: any) => k.eventType).filter(Boolean).sort()
    };
  }

  /** Real ADMIN / SUPER_ADMIN accounts (no invented rows). */
  async listAdmins() {
    const users = await prisma.user.findMany({
      where: { accountType: { in: [...ADMIN_TYPES] } },
      orderBy: [{ accountType: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true, accountType: true, status: true, lastActiveAt: true, createdAt: true }
    });
    return users.map((u: any) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, accountType: u.accountType, status: u.status, lastActiveAt: u.lastActiveAt, createdAt: u.createdAt }));
  }

  async getMe(userId: string) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, email: true, accountType: true, phoneCountryCode: true, phoneNumber: true, avatarUrl: true } });
    if (!u) throw new Error('USER_NOT_FOUND');
    return u;
  }

  /** Name / phone of the admin's own account. Writes a PROFILE_UPDATED audit entry listing the changed field names (values are masked by the audit sanitizer). */
  async updateMe(userId: string, input: unknown, ctx?: AuditContext) {
    const data = updateAdminProfileSchema.parse(input);
    const keys = Object.keys(data) as (keyof typeof data)[];
    if (!keys.length) throw new Error('NO_FIELDS');
    const before = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, phoneCountryCode: true, phoneNumber: true } });
    if (!before) throw new Error('USER_NOT_FOUND');
    if (data.phoneNumber) {
      const taken = await prisma.user.findFirst({ where: { phoneNumber: data.phoneNumber, id: { not: userId } }, select: { id: true } });
      if (taken) throw new Error('PHONE_TAKEN');
    }
    const updated = await prisma.user.update({ where: { id: userId }, data, select: { id: true, firstName: true, lastName: true, email: true, accountType: true, phoneCountryCode: true, phoneNumber: true, avatarUrl: true } });
    await accountAuditLogService.record({
      userId, eventType: 'PROFILE_UPDATED', category: 'PROFILE_COMPLETION', title: 'تعديل بيانات الحساب الإداري',
      summary: 'عدّل المسؤول بيانات حسابه الشخصي', source: 'USER', severity: 'INFO',
      before, after: Object.fromEntries(keys.map((k) => [k, (updated as any)[k]])), details: { changedFields: keys }, context: ctx
    });
    return updated;
  }

  listSessions(userId: string, currentSessionId?: string) {
    return sessionService.list(userId, currentSessionId);
  }

  /** Own sessions only: another account's session id is reported as SESSION_NOT_FOUND (404). The current session cannot be terminated here (use logout). */
  async terminateSession(userId: string, sessionId: string, currentSessionId?: string) {
    await sessionService.revoke(userId, sessionId, currentSessionId);
    return { revoked: 1 };
  }

  terminateOtherSessions(userId: string, currentSessionId?: string) {
    return sessionService.revokeOthers(userId, currentSessionId);
  }
}

export const adminAccountService = new AdminAccountService();
