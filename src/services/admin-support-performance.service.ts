import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { supportSlaSnapshot } from './case-sla.service';
import { responseMetrics } from './admin-support-response-metrics';

type Row = { id: string; userId: string; priority: string; status: string; createdAt: Date; firstReplyAt: Date | null; senderId: string | null };
export async function supportPerformance(period: 'month' | 'quarter' | 'year', now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const from = new Date(Date.UTC(y, period === 'year' ? 0 : period === 'quarter' ? Math.floor(m/3)*3 : m, 1));
  // Only aggregate timing/ids: no ticket text, contact details, attachments or review content.
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT t.id, t."userId", t.priority, t.status, t."createdAt",
      first_reply."createdAt" AS "firstReplyAt", first_reply."senderId" AS "senderId"
    FROM support_tickets t
    LEFT JOIN LATERAL (
      SELECT m."createdAt", m."senderId"
      FROM support_ticket_messages m
      JOIN users u ON u.id = m."senderId"
      WHERE m."ticketId" = t.id AND m."senderId" <> t."userId"
        AND u."accountType" IN ('ADMIN', 'SUPER_ADMIN')
        AND m."createdAt" >= t."createdAt" AND m."createdAt" <= ${now}
      ORDER BY m."createdAt" ASC, m.id ASC LIMIT 1
    ) first_reply ON TRUE
    WHERE t."createdAt" >= ${from} AND t."createdAt" <= ${now}
    ORDER BY t."createdAt" DESC, t.id DESC LIMIT 10001
  `);
  const covered = rows.slice(0, 10000);
  const measured = covered.map(t => ({
    createdAt: t.createdAt, firstReplyAt: t.firstReplyAt, senderId: t.senderId,
    closed: t.status === 'CLOSED' || t.status === 'RESOLVED',
    sla: supportSlaSnapshot(t, t.senderId && t.firstReplyAt ? [{
      senderId: t.senderId, createdAt: t.firstReplyAt, sender: { accountType: 'ADMIN' },
    }] : [], now)?.status ?? null,
  }));
  return {
    period, from: from.toISOString(), to: now.toISOString(), truncated: rows.length > 10000,
    ...responseMetrics(measured),
    definition: 'التذاكر المنشأة في الفترة حتى وقت القراءة. الرد الأول هو أول رسالة من حساب إداري غير صاحب التذكرة. الأهلية والمهلة من سياسة التصعيد المفعّلة، وبحسب الأولوية الحالية للتذكرة. النسبة تخص التذاكر المستحقة أو التي تم الرد عليها فقط، ولا تُنسب لموظف بعينه.',
  };
}
