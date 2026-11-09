import { AccountType, Prisma, LogCategory, LogStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { assigneeHolds } from './admin-access.service';

const HOUR = 3_600_000;
const DEFAULT_HOURS = [48, 24, 8, 2] as const; // low, normal, high, urgent
type Config = { from: Date; hours: number[]; supportTo?: string; disputesTo?: string };

type ConfigResult = { state: 'disabled' } | { state: 'invalid'; setting: string } | { state: 'configured'; config: Config };
const SUPPORT_PERMISSIONS = ['support.review', 'support.reply'];
const DISPUTE_PERMISSIONS = ['disputes.view', 'disputes.resolve'];

function parseCaseSlaConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env.CASE_SLA_ENABLED !== 'true') return { state: 'disabled' };
  const rawFrom = env.CASE_SLA_FROM ?? '';
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(rawFrom);
  const from = new Date(rawFrom);
  if (!m || !Number.isFinite(from.getTime()) || from.toISOString() !== `${m[1]}.${(m[2] ?? '').padEnd(3, '0')}Z`) {
    return { state: 'invalid', setting: 'CASE_SLA_FROM' };
  }
  const hours = env.SUPPORT_SLA_FIRST_REPLY_HOURS
    ? env.SUPPORT_SLA_FIRST_REPLY_HOURS.split(',').map(Number) : [...DEFAULT_HOURS];
  if (hours.length !== 4 || hours.some(h => !Number.isFinite(h) || h < 1 || h > 720)) {
    return { state: 'invalid', setting: 'SUPPORT_SLA_FIRST_REPLY_HOURS' };
  }
  const supportTo = env.SUPPORT_SLA_TARGET_ADMIN_ID?.trim();
  const disputesTo = env.DISPUTE_SLA_TARGET_ADMIN_ID?.trim();
  if (!supportTo && !disputesTo) return { state: 'invalid', setting: 'SUPPORT_SLA_TARGET_ADMIN_ID / DISPUTE_SLA_TARGET_ADMIN_ID' };
  return { state: 'configured', config: { from, hours, supportTo, disputesTo } };
}

export function readCaseSlaConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const result = parseCaseSlaConfig(env);
  return result.state === 'configured' ? result.config : null;
}

/** Check settings and permissions without assigning anything or starting the worker. */
export async function checkCaseSlaReadiness(env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  const result = parseCaseSlaConfig(env);
  if (result.state !== 'configured') return result;
  const { from, hours, supportTo, disputesTo } = result.config;
  const check = async (target: string | undefined, permissions: string[]) =>
    !target ? 'not-configured' : await assigneeHolds(target, permissions) ? 'eligible' : 'ineligible';
  const [support, disputes] = await Promise.all([check(supportTo, SUPPORT_PERMISSIONS), check(disputesTo, DISPUTE_PERMISSIONS)]);
  const state = support === 'ineligible' || disputes === 'ineligible' ? 'ineligible' : now < from ? 'scheduled' : 'ready';
  return { state, from: from.toISOString(), hours, support, disputes };
}

type Ticket = { createdAt: Date; priority: string; status: string; userId: string };
type Message = { senderId: string; sender?: { accountType?: string } | null; createdAt: Date };
export function supportSlaSnapshot(ticket: Ticket, messages: Message[], now = new Date()) {
  const cfg = readCaseSlaConfig();
  const opened = ticket.createdAt?.getTime();
  if (!cfg?.supportTo || !Number.isFinite(opened) || opened < cfg.from.getTime()) return null;
  const index = ticket.priority === 'منخفضة' ? 0 : ticket.priority === 'عالية' ? 2 : ticket.priority === 'عاجلة' ? 3 : 1;
  const hours = cfg.hours[index];
  const dueAt = new Date(opened + hours * HOUR);
  const first = messages.find(m => m.senderId !== ticket.userId && (m.sender?.accountType === AccountType.ADMIN || m.sender?.accountType === AccountType.SUPER_ADMIN));
  const closed = ticket.status === 'CLOSED' || ticket.status === 'RESOLVED';
  return {
    hours, dueAt,
    status: first ? (first.createdAt <= dueAt ? 'MET' : 'LATE') : closed ? 'CLOSED' : now >= dueAt ? 'OVERDUE' : 'PENDING',
  };
}

type CaseKind = 'TICKET' | 'DISPUTE';
async function sweepCaseKind(cfg: Config, kind: CaseKind, now: Date) {
  const ticket = kind === 'TICKET';
  const target = ticket ? cfg.supportTo : cfg.disputesTo;
  if (!target || !await assigneeHolds(target, ticket ? SUPPORT_PERMISSIONS : DISPUTE_PERMISSIONS)) return 0;
  const recipient = await prisma.user.findUnique({ where: { id: target }, select: { firstName: true, lastName: true } });
  if (!recipient) return 0;
  const assigneeName = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ');
  const [low, normal, high, urgent] = cfg.hours;
  return prisma.$transaction(async tx => {
    const ids = await tx.$queryRaw<{ id: string }[]>(ticket ? Prisma.sql`
      SELECT t.id FROM support_tickets t
      WHERE t.status IN ('OPEN','IN_PROGRESS')
        AND t."createdAt" >= ${cfg.from}
        AND t."createdAt" + (CASE t.priority WHEN 'منخفضة' THEN ${low}::double precision
          WHEN 'عالية' THEN ${high}::double precision WHEN 'عاجلة' THEN ${urgent}::double precision
          ELSE ${normal}::double precision END) * interval '1 hour' <= ${now}
        AND NOT EXISTS (
          SELECT 1 FROM support_ticket_messages m JOIN users u ON u.id = m."senderId"
          WHERE m."ticketId" = t.id AND m."senderId" <> t."userId" AND u."accountType" IN ('ADMIN','SUPER_ADMIN')
        )
        AND NOT EXISTS (
          SELECT 1 FROM account_audit_logs a WHERE a.source IN ('ADMIN','SYSTEM') AND a."eventType" = 'TICKET_ASSIGNED'
            AND a.context->>'entityId' = t.id AND a.context->>'escalationReason' IS NOT NULL
        )
      ORDER BY t."createdAt", t.id LIMIT 25 FOR UPDATE OF t SKIP LOCKED
    ` : Prisma.sql`
      SELECT d.id FROM disputes d
      WHERE d.status IN ('OPEN','UNDER_REVIEW')
        AND d."createdAt" >= ${cfg.from} AND d."createdAt" < ${new Date(now.getTime() - 168 * HOUR)}
        AND NOT EXISTS (
          SELECT 1 FROM account_audit_logs a WHERE a.source IN ('ADMIN','SYSTEM') AND a."eventType" = 'DISPUTE_ASSIGNED'
            AND a.context->>'entityId' = d.id AND a.context->>'escalationReason' IS NOT NULL
        )
      ORDER BY d."createdAt", d.id LIMIT 25 FOR UPDATE OF d SKIP LOCKED
    `);
    if (!ids.length) return 0;
    const reason = ticket ? 'تجاوز مهلة أول رد من الدعم' : 'النزاع ما زال مفتوحًا بعد سبعة أيام';
    const written = await tx.accountAuditLog.createMany({ skipDuplicates: true, data: ids.map(({ id }) => ({
      userId: target, category: LogCategory.SYSTEM_AUDIT, status: LogStatus.COMPLETED,
      title: 'تصعيد تلقائي', actionText: reason, summary: reason, eventType: kind + '_ASSIGNED',
      source: 'SYSTEM', actorLabel: 'النظام', severity: 'WARNING',
      context: { entity: kind, entityId: id, assigneeId: target, assigneeName, escalationReason: reason, automatic: true },
    })) });
    return written.count;
  }, { timeout: 15_000 });
}

export async function runCaseSlaOnce(now = new Date()) {
  const cfg = readCaseSlaConfig();
  if (!cfg || now < cfg.from) return { tickets: 0, disputes: 0 };
  const tickets = await sweepCaseKind(cfg, 'TICKET', now);
  const disputes = await sweepCaseKind(cfg, 'DISPUTE', now);
  return { tickets, disputes };
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startCaseSlaScheduler() {
  if (timer || !readCaseSlaConfig()) return;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runCaseSlaOnce().catch(error => logger.error('[case-sla] sweep failed: ' + ((error as Error).name || 'Error'))).finally(() => { running = false; });
  };
  timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
}
