import { LogCategory, LogStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';

export interface AuditContext { sessionId?: string; ipAddress?: string; device?: string; actorLabel?: string; correlationId?: string }
export interface AuditEventInput { userId: string; eventType: string; category: LogCategory; title: string; summary: string; status?: LogStatus; statusText?: string; source?: 'USER' | 'AI' | 'ADMIN' | 'SYSTEM'; severity?: 'INFO' | 'WARNING' | 'CRITICAL'; before?: unknown; after?: unknown; details?: Record<string, unknown>; requestId?: string; canResubmit?: boolean; context?: AuditContext }
export interface AuditQuery { page?: number; limit?: number; category?: string; status?: string; source?: string; eventType?: string; search?: string; from?: string; to?: string }

export class AccountAuditLogService {
  async record(input: AuditEventInput) {
    const context = input.context || {};
    return prisma.accountAuditLog.create({ data: {
      userId: input.userId, category: input.category, title: this.cleanText(input.title, 140), actionText: this.cleanText(input.summary, 500), summary: this.cleanText(input.summary, 500), eventType: this.cleanCode(input.eventType), source: input.source || 'SYSTEM', severity: input.severity || 'INFO', status: input.status || LogStatus.COMPLETED, statusText: input.statusText ? this.cleanText(input.statusText, 180) : undefined, canResubmit: Boolean(input.canResubmit), beforeData: this.toJson(this.sanitize(input.before)), afterData: this.toJson(this.sanitize(input.after)), metaData: this.toJson(this.sanitize(input.details)), context: this.toJson(this.sanitize({ correlationId: context.correlationId })), requestId: input.requestId, sessionId: context.sessionId, ipAddress: context.ipAddress ? this.cleanText(context.ipAddress, 80) : undefined, device: context.device ? this.cleanText(context.device, 120) : undefined, actorLabel: context.actorLabel ? this.cleanText(context.actorLabel, 120) : undefined, occurredAt: new Date()
    } });
  }

  async logAction(userId: string, data: { category: LogCategory; title: string; actionText: string; status?: LogStatus; statusText?: string; canResubmit?: boolean; metaData?: any }) {
    return this.record({ userId, eventType: this.legacyEventType(data.category), category: data.category, title: data.title, summary: data.actionText, status: data.status, statusText: data.statusText, canResubmit: data.canResubmit, details: data.metaData });
  }

  async getUserLogs(userId: string, query: AuditQuery = {}) {
    const page = this.boundedInt(query.page, 1, 1, 100000), limit = this.boundedInt(query.limit, 20, 1, 50), where = this.buildWhere(userId, query);
    const [items, total, aggregates] = await prisma.$transaction([
      prisma.accountAuditLog.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.accountAuditLog.count({ where }),
      prisma.accountAuditLog.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } })
    ]);
    const counts = Object.fromEntries(aggregates.map(item => [item.status, item._count._all]));
    return { items: items.map(item => this.toListItem(item)), pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }, counts: { total: Object.values(counts).reduce((sum, count) => sum + Number(count), 0), pending: Number(counts.IN_REVIEW || 0), approved: Number(counts.APPROVED || 0), rejected: Number(counts.REJECTED || 0), completed: Number(counts.COMPLETED || 0) } };
  }

  async getUserLog(userId: string, id: string) {
    const item = await prisma.accountAuditLog.findFirst({ where: { id, userId } });
    if (!item) throw new Error('AUDIT_LOG_NOT_FOUND');
    return { ...this.toListItem(item), before: this.sanitize(item.beforeData), after: this.sanitize(item.afterData), details: this.sanitize(item.metaData), statusText: item.statusText, requestId: item.requestId, actorLabel: item.actorLabel };
  }

  private buildWhere(userId: string, query: AuditQuery): Prisma.AccountAuditLogWhereInput {
    const where: Prisma.AccountAuditLogWhereInput = { userId };
    if (query.category && Object.values(LogCategory).includes(query.category as LogCategory)) where.category = query.category as LogCategory;
    if (query.status && Object.values(LogStatus).includes(query.status as LogStatus)) where.status = query.status as LogStatus;
    if (query.source && ['USER', 'AI', 'ADMIN', 'SYSTEM'].includes(query.source)) where.source = query.source;
    if (query.eventType) where.eventType = this.cleanCode(query.eventType);
    if (query.search) { const search = this.cleanText(query.search, 80); where.OR = [{ title: { contains: search, mode: 'insensitive' } }, { actionText: { contains: search, mode: 'insensitive' } }, { eventType: { contains: search, mode: 'insensitive' } }]; }
    const occurredAt: Prisma.DateTimeFilter = {};
    if (query.from && !Number.isNaN(Date.parse(query.from))) occurredAt.gte = new Date(query.from);
    if (query.to && !Number.isNaN(Date.parse(query.to))) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); occurredAt.lte = end; }
    if (occurredAt.gte || occurredAt.lte) where.occurredAt = occurredAt;
    return where;
  }

  private toListItem(item: any) { return { id: item.id, eventType: item.eventType || this.legacyEventType(item.category), category: item.category, title: item.title, summary: item.summary || item.actionText, status: item.status, statusText: item.statusText, source: item.source || 'SYSTEM', severity: item.severity || 'INFO', canResubmit: item.canResubmit, occurredAt: item.occurredAt || item.createdAt, ipAddress: item.ipAddress || null, device: item.device || null, sessionId: item.sessionId || null, hasDetails: Boolean(item.beforeData || item.afterData || item.metaData || item.requestId) }; }
  private sanitize(value: unknown, key = '', depth = 0): any {
    if (value === undefined || value === null) return value ?? null;
    if (depth > 5) return '[تم اختصار البيانات]';
    const normalizedKey = key.toLowerCase();
    if (/(password|token|secret|authorization|otp|code|hash)/.test(normalizedKey)) return '[محجوب]';
    if (Array.isArray(value)) return value.slice(0, 20).map(item => this.sanitize(item, key, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 60).map(([childKey, child]) => [childKey, this.sanitize(child, childKey, depth + 1)]));
    const text = String(value);
    if (/iban|accountnumber/.test(normalizedKey)) return text.length > 4 ? `${'*'.repeat(Math.min(12, text.length - 4))}${text.slice(-4)}` : '****';
    if (/email/.test(normalizedKey)) { const [name, domain] = text.split('@'); return domain ? `${name.slice(0, 2)}***@${domain}` : '[بريد محجوب]'; }
    if (/phone|mobile/.test(normalizedKey)) return text.length > 4 ? `${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}` : '****';
    if (/(document|certificate|registration|attachment|file|avatar|image|proof|url)/.test(normalizedKey)) return this.fileLabel(text);
    return typeof value === 'string' ? this.cleanText(value, 500) : value;
  }
  private fileLabel(value: string) { try { const path = new URL(value).pathname; return decodeURIComponent(path.split('/').filter(Boolean).pop() || 'ملف مرفق').slice(-160); } catch { return value.startsWith('data:') ? 'ملف مرفق' : this.cleanText(value.split(/[\\/]/).pop() || 'ملف مرفق', 160); } }
  private toJson(value: unknown): Prisma.InputJsonValue | undefined { return value === undefined ? undefined : value as Prisma.InputJsonValue; }
  private cleanText(value: string, max: number) { return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max); }
  private cleanCode(value: string) { return String(value || 'SYSTEM_EVENT').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80); }
  private boundedInt(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
  private legacyEventType(category: LogCategory) { return category === LogCategory.ROLE_ADDITION ? 'ROLE_ADDED' : category === LogCategory.PROFILE_COMPLETION ? 'PROFILE_UPDATED' : category === LogCategory.SECURITY_CHANGE ? 'SECURITY_CHANGED' : 'SYSTEM_EVENT'; }
}

export const accountAuditLogService = new AccountAuditLogService();
