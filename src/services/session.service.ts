import crypto from 'crypto';
import { systemSettingsService } from './system-settings.service';
import { prisma } from '../config/db';
import { accountAuditLogService } from './account-logs.service';

export interface SessionContext { ipAddress?: string; userAgent?: string }

class SessionService {
  private tokenHash(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }

  /** read-only: is this exact token a live (not revoked, not expired) session? */
  async isActiveToken(token: string): Promise<boolean> {
    const s = await prisma.userSession.findUnique({ where: { tokenHash: this.tokenHash(token) }, select: { revokedAt: true, expiresAt: true } });
    return !!s && !s.revokedAt && s.expiresAt > new Date();
  }

  /** how many live sessions would end at their next request if the idle limit were `minutes` (preview shown before the setting is saved) */
  async idleImpact(minutes: number): Promise<{ activeSessions: number; wouldEndNow: number }> {
    const now = new Date();
    const live = { revokedAt: null, expiresAt: { gt: now } };
    const [activeSessions, wouldEndNow] = await Promise.all([
      prisma.userSession.count({ where: live }),
      minutes > 0 ? prisma.userSession.count({ where: { ...live, lastActiveAt: { lt: new Date(now.getTime() - minutes * 60000) } } }) : Promise.resolve(0),
    ]);
    return { activeSessions, wouldEndNow };
  }

  private describe(userAgent = '') {
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'متصفح غير معروف';
    const os = /Windows NT 10/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'نظام غير معروف';
    const device = /Mobile|Android|iPhone/.test(userAgent) ? 'هاتف' : /iPad|Tablet/.test(userAgent) ? 'جهاز لوحي' : 'حاسوب';
    return { browser, os, device };
  }

  async register(userId: string, token: string, context: SessionContext, expiresAt = new Date(Date.now() + 7 * 86400000)) {
    const details = this.describe(context.userAgent);
    const hash = this.tokenHash(token);
    const existed = await prisma.userSession.findUnique({ where: { tokenHash: hash }, select: { id: true } });
    const session = await prisma.userSession.upsert({
      where: { tokenHash: hash },
      create: { userId, tokenHash: hash, ...context, ...details, expiresAt },
      update: { lastActiveAt: new Date(), ipAddress: context.ipAddress, userAgent: context.userAgent, ...details }
    });
    if (!existed) await accountAuditLogService.record({ userId, eventType: 'SESSION_STARTED', category: 'SECURITY_CHANGE', title: 'تسجيل دخول جديد', summary: `بدأت جلسة جديدة عبر ${details.browser} على ${details.os}`, source: 'USER', severity: 'INFO', status: 'COMPLETED', details, context: { sessionId: session.id, ipAddress: context.ipAddress, device: `${details.device} · ${details.browser} · ${details.os}` } });
    return session;
  }

  async validateOrRegister(userId: string, token: string, context: SessionContext, expiresAt?: Date) {
    const hash = this.tokenHash(token);
    const existing = await prisma.userSession.findUnique({ where: { tokenHash: hash } });
    if (existing?.revokedAt || (existing && existing.expiresAt <= new Date())) return null;
    if (!existing) return this.register(userId, token, context, expiresAt);
    // Setting `sessionIdleMinutes` (0 = off): a session idle for longer is ended at its next request - sessions that already exist included. lastActiveAt is refreshed at most once a minute, hence the 5-minute floor.
    const idleMinutes = await systemSettingsService.get<number>('sessionIdleMinutes');
    if (idleMinutes > 0 && Date.now() - existing.lastActiveAt.getTime() > idleMinutes * 60000) {
      await prisma.userSession.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
      return null;
    }
    if (Date.now() - existing.lastActiveAt.getTime() > 60000) await prisma.userSession.update({ where: { id: existing.id }, data: { lastActiveAt: new Date(), ipAddress: context.ipAddress } });
    return existing;
  }

  async list(userId: string, currentSessionId?: string) {
    await prisma.userSession.updateMany({ where: { userId, expiresAt: { lte: new Date() }, revokedAt: null }, data: { revokedAt: new Date() } });
    const sessions = await prisma.userSession.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastActiveAt: 'desc' } });
    return sessions.map(({ tokenHash: _tokenHash, userAgent: _userAgent, ...session }) => ({ ...session, isCurrent: session.id === currentSessionId }));
  }

  async revoke(userId: string, sessionId: string, currentSessionId?: string) {
    if (sessionId === currentSessionId) throw new Error('CANNOT_REVOKE_CURRENT_SESSION');
    const result = await prisma.userSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!result.count) throw new Error('SESSION_NOT_FOUND');
    await accountAuditLogService.record({ userId, eventType: 'SESSION_REVOKED', category: 'SECURITY_CHANGE', title: 'إنهاء جلسة دخول', summary: 'تم إنهاء وصول جهاز آخر إلى الحساب', source: 'USER', severity: 'WARNING', status: 'COMPLETED', requestId: sessionId, context: { sessionId: currentSessionId } });
  }

  /**
   * Ends EVERY active session of the account (optionally keeping one, e.g. the device that just changed the password). Used when the
   * password is reset or changed (AUD-FND-000034). Revoked rows are rejected by validateOrRegister() on the next request.
   */
  async revokeAll(userId: string, reason: 'PASSWORD_RESET' | 'PASSWORD_CHANGED', exceptSessionId?: string) {
    const result = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() }
    });
    await accountAuditLogService.record({
      userId,
      eventType: 'SESSIONS_REVOKED_ALL',
      category: 'SECURITY_CHANGE',
      title: 'إنهاء جميع جلسات الدخول',
      summary: reason === 'PASSWORD_RESET' ? 'تم إنهاء جميع جلسات الدخول بعد إعادة تعيين كلمة المرور' : 'تم إنهاء جلسات الدخول الأخرى بعد تغيير كلمة المرور',
      source: 'SYSTEM',
      severity: 'WARNING',
      status: 'COMPLETED',
      details: { revokedSessions: result.count, reason }
    });
    return result;
  }

  /** Ends every active session of the account except the current one ("terminate all others"); one audit entry records the count. */
  async revokeOthers(userId: string, currentSessionId?: string) {
    const result = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
      data: { revokedAt: new Date() }
    });
    await accountAuditLogService.record({
      userId,
      eventType: 'SESSIONS_REVOKED_OTHERS',
      category: 'SECURITY_CHANGE',
      title: 'إنهاء جلسات الدخول الأخرى',
      summary: 'أنهى المستخدم جميع جلسات الدخول الأخرى وأبقى الجلسة الحالية',
      source: 'USER',
      severity: 'WARNING',
      status: 'COMPLETED',
      details: { revokedSessions: result.count },
      context: { sessionId: currentSessionId }
    });
    return { revoked: result.count };
  }

  async logout(userId: string, token: string, context?: SessionContext) {
    const hash = this.tokenHash(token);
    await prisma.userSession.updateMany({
      where: { tokenHash: hash, userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    await accountAuditLogService.record({
      userId,
      eventType: 'SESSION_LOGOUT',
      category: 'SECURITY_CHANGE',
      title: 'تسجيل الخروج',
      summary: 'تم تسجيل الخروج بنجاح من هذا الجهاز',
      source: 'USER',
      severity: 'INFO',
      status: 'COMPLETED',
      context
    });
  }
}

export const sessionService = new SessionService();
