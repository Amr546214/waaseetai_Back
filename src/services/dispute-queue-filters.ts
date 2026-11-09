import { Prisma } from '@prisma/client';
import { fieldError } from '../utils/app-error';

/**
 * Search + filters of the admin dispute queue. Everything here is turned into ONE database condition that is applied BEFORE pagination (total / pages / order are about the filtered set).
 * Nothing here widens what disputes.view already sees: no message bodies and no personal data are searched, only the dispute id and the request / project reference ids it points to.
 */
export const DISPUTE_SEARCH_MIN = 4;
export const DISPUTE_MAX_RANGE_DAYS = 366;
const HEX = /^[0-9a-f-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

export type DisputeAssigneeFilter = { kind: 'me' } | { kind: 'unassigned' } | { kind: 'staff'; id: string };
export interface DisputeQueueFilters { q?: string; assignee?: DisputeAssigneeFilter; createdFrom?: Date; createdTo?: Date }

function single(raw: unknown, name: string, label: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw fieldError(name, `${label} غير صحيح`, 400);
  const v = raw.trim();
  return v === '' ? undefined : v;
}

function parseBound(raw: string, which: 'from' | 'to', name: string, label: string): Date {
  const bad = () => fieldError(name, `${label} غير صالح: استخدم صيغة التاريخ YYYY-MM-DD`, 400);
  const d = DATE_ONLY.exec(raw);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const start = new Date(Date.UTC(y, m - 1, day));
    if (start.getUTCFullYear() !== y || start.getUTCMonth() !== m - 1 || start.getUTCDate() !== day) throw bad();
    return which === 'from' ? start : new Date(start.getTime() + 86_400_000 - 1);
  }
  if (!DATE_TIME.test(raw)) throw bad();
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const t = new Date(withZone);
  if (Number.isNaN(t.getTime())) throw bad();
  return t;
}

/** `canPickStaff`: the actor may name an arbitrary staff member (team.view, the same visibility as the staff list). `me` and `unassigned` are open to everyone who holds disputes.view. */
export function parseDisputeQueueFilters(query: Record<string, unknown>, opts: { canPickStaff: boolean }): DisputeQueueFilters {
  const out: DisputeQueueFilters = {};

  const rawQ = single(query.q, 'q', 'نص البحث');
  if (rawQ !== undefined) {
    // The UI shows the short number as `#3f6fa186…`: accept that form back.
    const q = rawQ.replace(/^#/, '').replace(/(…|\.\.\.)$/, '').trim().toLowerCase();
    if (q.length < DISPUTE_SEARCH_MIN) throw fieldError('q', `اكتب ${DISPUTE_SEARCH_MIN} أحرف على الأقل للبحث برقم النزاع أو مرجع الطلب أو المشروع`, 400);
    if (q.length > 36 || !HEX.test(q)) throw fieldError('q', 'صيغة البحث غير صحيحة: ابحث برقم النزاع أو مرجع الطلب أو المشروع (أحرف وأرقام من 0-9 و a-f)', 400);
    out.q = q;
  }

  const rawAssignee = single(query.assignee, 'assignee', 'فلتر المسؤول');
  if (rawAssignee !== undefined) {
    const v = rawAssignee.toLowerCase();
    if (v === 'me') out.assignee = { kind: 'me' };
    else if (v === 'unassigned') out.assignee = { kind: 'unassigned' };
    else if (UUID.test(v)) {
      if (!opts.canPickStaff) throw fieldError('assignee', 'اختيار مسؤول محدد يتطلب صلاحية عرض الفريق. يمكنك الفلترة بـ «المعيّن لي» أو «غير معيّن».', 403);
      out.assignee = { kind: 'staff', id: v };
    } else throw fieldError('assignee', 'فلتر المسؤول غير صحيح: استخدم me أو unassigned أو معرّف عضو الفريق', 400);
  }

  const rawFrom = single(query.createdFrom, 'createdFrom', 'تاريخ البداية');
  const rawTo = single(query.createdTo, 'createdTo', 'تاريخ النهاية');
  if (rawFrom !== undefined) out.createdFrom = parseBound(rawFrom, 'from', 'createdFrom', 'تاريخ البداية');
  if (rawTo !== undefined) out.createdTo = parseBound(rawTo, 'to', 'createdTo', 'تاريخ النهاية');
  if (out.createdFrom && out.createdTo) {
    if (out.createdFrom.getTime() > out.createdTo.getTime()) throw fieldError('createdFrom', 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية', 400);
    if ((out.createdTo.getTime() - out.createdFrom.getTime()) / 86_400_000 > DISPUTE_MAX_RANGE_DAYS) throw fieldError('createdTo', `الفترة الزمنية طويلة: الحد الأقصى ${DISPUTE_MAX_RANGE_DAYS} يومًا`, 400);
  }
  return out;
}

type Db = { $queryRaw: <T = unknown>(q: Prisma.Sql) => Promise<T> };

/** Dispute ids that have a current assignee, optionally only this one. Current assignee = newest DISPUTE_ASSIGNED audit row that names somebody (same rule as the row's `assignedTo`). */
export async function assignedDisputeIds(db: Db, assigneeId?: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t.entity_id AS id FROM (
      SELECT DISTINCT ON (context->>'entityId') context->>'entityId' AS entity_id, context->>'assigneeId' AS assignee_id
      FROM account_audit_logs
      WHERE "eventType" = 'DISPUTE_ASSIGNED' AND source IN ('ADMIN', 'SYSTEM') AND context->>'entityId' IS NOT NULL AND context->>'assigneeId' IS NOT NULL
      ORDER BY context->>'entityId', "occurredAt" DESC, id DESC
    ) t
    ${assigneeId ? Prisma.sql`WHERE t.assignee_id = ${assigneeId}` : Prisma.empty}`);
  return rows.map(r => r.id);
}

/** The non-status conditions as one Prisma where. Resolved once, before any pagination. */
export async function disputeFilterWhere(db: Db, f: DisputeQueueFilters, actorId: string | undefined): Promise<Prisma.DisputeWhereInput[]> {
  const and: Prisma.DisputeWhereInput[] = [];
  if (f.q) and.push({ OR: [{ id: { startsWith: f.q } }, { requestId: { startsWith: f.q } }, { projectId: { startsWith: f.q } }] });
  if (f.assignee) {
    if (f.assignee.kind === 'unassigned') and.push({ id: { notIn: await assignedDisputeIds(db) } });
    else {
      const who = f.assignee.kind === 'me' ? actorId : f.assignee.id;
      and.push({ id: { in: who ? await assignedDisputeIds(db, who) : [] } });
    }
  }
  if (f.createdFrom || f.createdTo) and.push({ createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lte: f.createdTo } : {}) } });
  return and;
}
