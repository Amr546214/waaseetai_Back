import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { accountAuditLogService, AuditContext } from './account-logs.service';
import { sessionService } from './session.service';
import { listAuditTrail } from './admin-audit-trail.service';

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
   * The admin audit trail (see admin-audit-trail.service): real account_audit_logs rows + the admin access trail, each with its own event identity,
   * actor, target and detail. Default scope "admin" = events about an ADMIN/SUPER_ADMIN account or performed by an admin (source ADMIN) + the access trail;
   * scope "all" = the whole account log. Filters: actor (who did it), event type, severity, source, date range, text, page.
   */
  async listAuditLog(query: AuditLogQuery) {
    return listAuditTrail(query);
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
