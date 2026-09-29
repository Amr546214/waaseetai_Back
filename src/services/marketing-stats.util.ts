import { OrderStatus } from '@prisma/client';

// Shared helpers for the per-tool stats endpoints
// (GET /provider/coupons/:id/stats, GET /provider/special-offers/:id/stats).
// Same conventions as marketing-center.service.ts: redemptions on CANCELLED
// orders are excluded, money is rounded to 2 decimals, all dates are UTC.

export const NOT_CANCELLED = { status: { not: OrderStatus.CANCELLED } };
export const TREND_WEEKS = 6; // designs P-PR-040/041-تفاصيل: "آخر 6 أسابيع"
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

export const round2 = (n: number) => Math.round(n * 100) / 100;

export type StatsPaging = { page: number; pageSize: number };

export function parsePaging(query: { page?: unknown; pageSize?: unknown } = {}): StatsPaging {
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.pageSize)) || DEFAULT_PAGE_SIZE));
  return { page, pageSize };
}

/**
 * Rolling 7-day buckets ending at `now` (oldest first). A rolling window
 * rather than calendar weeks so the last bucket is always a full week and
 * "آخر 6 أسابيع" covers exactly the last 42 days.
 */
export function weeklyTrend(rows: { amount: number; createdAt: Date }[], now: Date, weeks = TREND_WEEKS) {
  const end = now.getTime();
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const to = end - (weeks - 1 - i) * WEEK_MS;
    return { weekStart: new Date(to - WEEK_MS), weekEnd: new Date(to), usageCount: 0, discountedValue: 0 };
  });
  for (const r of rows) {
    const t = new Date(r.createdAt).getTime();
    if (t > end || t <= end - weeks * WEEK_MS) continue;
    const idx = weeks - 1 - Math.floor((end - t) / WEEK_MS);
    const bucket = buckets[Math.min(Math.max(idx, 0), weeks - 1)];
    bucket.usageCount += 1;
    bucket.discountedValue += r.amount;
  }
  return buckets.map(b => ({ ...b, discountedValue: round2(b.discountedValue) }));
}

/** Sum of order totals counting each order once (an order can carry several redemptions). */
export function distinctOrderRevenue(rows: { orderId: string; order: { total: number } | null }[]) {
  const orders = new Map<string, number>();
  for (const r of rows) orders.set(r.orderId, r.order?.total ?? 0);
  return round2([...orders.values()].reduce((a, v) => a + v, 0));
}

export function pageMeta(paging: StatsPaging, total: number) {
  return { page: paging.page, pageSize: paging.pageSize, total, totalPages: Math.max(1, Math.ceil(total / paging.pageSize)) };
}

export const customerName = (user: { firstName: string; lastName: string } | null | undefined) =>
  user ? `${user.firstName} ${user.lastName}`.trim() : null;
