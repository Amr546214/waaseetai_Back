import { Prisma, SupportTicketStatus } from '@prisma/client';

interface EscalationPage {
  status?: SupportTicketStatus;
  userId?: string;
  q?: string;
  offset: number;
  limit: number;
}

/** Match the latest assignment, not any historical escalation; page in SQL before fetching rows. */
export function supportEscalationQuery(page?: EscalationPage) {
  const conditions: Prisma.Sql[] = [];
  if (page?.status) conditions.push(Prisma.sql`status = ${page.status}::"SupportTicketStatus"`);
  if (page?.userId) conditions.push(Prisma.sql`"userId" = ${page.userId}`);
  if (page?.q) conditions.push(Prisma.sql`(strpos(lower("ticketNumber"), lower(${page.q})) > 0 OR strpos(lower(subject), lower(${page.q})) > 0)`);
  const scope = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  const rows = page ? Prisma.sql`
    , matching AS (SELECT id, "createdAt" FROM active_escalations ${scope})
    SELECT
      (SELECT count(*)::int FROM active_escalations) AS "escalatedCount",
      (SELECT count(*)::int FROM matching) AS total,
      ARRAY(SELECT id FROM matching ORDER BY "createdAt" DESC, id DESC OFFSET ${page.offset} LIMIT ${page.limit}) AS ids
  ` : Prisma.sql`SELECT count(*)::int AS "escalatedCount" FROM active_escalations`;

  return Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (context->>'entityId')
        context->>'entityId' AS "ticketId", context
      FROM account_audit_logs
      WHERE source IN ('ADMIN', 'SYSTEM') AND "eventType" = 'TICKET_ASSIGNED' AND context->>'entity' = 'TICKET'
      ORDER BY context->>'entityId', "occurredAt" DESC, id DESC
    ), active_escalations AS (
      SELECT t.id, t."createdAt", t."userId", t."ticketNumber", t.subject, t.status
      FROM latest a JOIN support_tickets t ON t.id = a."ticketId"
      WHERE t.status IN ('OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER')
        AND jsonb_typeof(a.context->'escalationReason') = 'string'
        AND btrim(a.context->>'escalationReason') <> ''
    )
    ${rows}
  `;
}
