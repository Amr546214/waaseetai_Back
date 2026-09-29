import { AccountType, OrderStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

// Phase 7 — مركز التسويق (Marketing Center) aggregation.
// Every number here is derived from the real Coupon / CouponRedemption /
// SpecialOffer / SpecialOfferRedemption rows of the authenticated provider
// (Coupon/SpecialOffer.providerId is the provider's — or company owner's —
// own User.id, see provider-coupon.service.ts). Nothing is estimated:
// when a comparison has no baseline (previous month = 0) the delta is null.
//
// Redemptions on CANCELLED orders are excluded everywhere (they neither
// cost the provider a discount nor produced revenue).
// Month boundaries are calendar months in UTC.

const TREND_MONTHS = 6;
const TOP_TOOLS_LIMIT = 10;
const NOT_CANCELLED = { status: { not: OrderStatus.CANCELLED } };

export type ToolStatus = 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'PENDING' | 'REJECTED';

const round2 = (n: number) => Math.round(n * 100) / 100;
const monthStart = (year: number, month: number) => new Date(Date.UTC(year, month, 1));
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function toolStatus(tool: { active: boolean; expiresAt: Date | null; approvalStatus: string }, now: Date): ToolStatus {
  if (tool.approvalStatus === 'PENDING') return 'PENDING';
  if (tool.approvalStatus === 'REJECTED') return 'REJECTED';
  if (tool.expiresAt && tool.expiresAt < now) return 'EXPIRED';
  return tool.active ? 'ACTIVE' : 'PAUSED';
}

function summarize(statuses: ToolStatus[]) {
  const summary = { total: statuses.length, active: 0, paused: 0, expired: 0, pending: 0, rejected: 0 };
  for (const s of statuses) summary[s.toLowerCase() as 'active'] += 1;
  return summary;
}

type WindowRedemption = { amount: number; createdAt: Date; orderId: string; order: { total: number } | null };
type ToolStats = { usageCount: number; discountedValue: number; lastUsedAt: Date | null };

export class MarketingCenterService {
  async getCenter(providerId: string, now: Date = new Date()) {
    const user = await prisma.user.findUnique({ where: { id: providerId }, select: { accountType: true, marketingMonthlySpendCap: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);
    const isCompany = user.accountType === AccountType.PROVIDER_COMPANY;

    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const thisMonthStart = monthStart(y, m);
    const prevMonthStart = monthStart(y, m - 1);
    const nextMonthStart = monthStart(y, m + 1);
    const windowStart = monthStart(y, m - (TREND_MONTHS - 1));

    const assigneeSelect = { select: { id: true, name: true, avatarUrl: true } } as const;
    const windowWhere = { createdAt: { gte: windowStart, lt: nextMonthStart }, order: NOT_CANCELLED };

    const [coupons, offers, couponWindow, offerWindow, couponGroups, offerGroups, teamMembers] = await Promise.all([
      prisma.coupon.findMany({
        where: { providerId },
        select: { id: true, code: true, active: true, expiresAt: true, approvalStatus: true, usedCount: true, maxUses: true, createdAt: true, assignedToTeamMemberId: true, assignedToTeamMember: assigneeSelect }
      }),
      prisma.specialOffer.findMany({
        where: { providerId },
        select: { id: true, name: true, type: true, active: true, expiresAt: true, approvalStatus: true, usedCount: true, createdAt: true, assignedToTeamMemberId: true, assignedToTeamMember: assigneeSelect }
      }),
      prisma.couponRedemption.findMany({
        where: { coupon: { providerId }, ...windowWhere },
        select: { amount: true, createdAt: true, orderId: true, order: { select: { total: true } } }
      }),
      prisma.specialOfferRedemption.findMany({
        where: { offer: { providerId }, ...windowWhere },
        select: { amount: true, createdAt: true, orderId: true, order: { select: { total: true } } }
      }),
      prisma.couponRedemption.groupBy({
        by: ['couponId'],
        where: { coupon: { providerId }, order: NOT_CANCELLED },
        _count: { _all: true }, _sum: { amount: true }, _max: { createdAt: true }
      }),
      prisma.specialOfferRedemption.groupBy({
        by: ['offerId'],
        where: { offer: { providerId }, order: NOT_CANCELLED },
        _count: { _all: true }, _sum: { amount: true }, _max: { createdAt: true }
      }),
      isCompany
        ? prisma.companyTeamMember.findMany({ where: { companyOwnerId: providerId }, select: { id: true, name: true, avatarUrl: true, jobTitle: true, status: true }, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([])
    ]);

    // --- Monthly buckets (trend + this/previous month KPIs) ---------------
    const buckets = new Map<string, { usageCount: number; discountedValue: number; orders: Map<string, number> }>();
    for (let i = TREND_MONTHS - 1; i >= 0; i--) buckets.set(monthKey(monthStart(y, m - i)), { usageCount: 0, discountedValue: 0, orders: new Map() });
    for (const r of [...couponWindow, ...offerWindow] as WindowRedemption[]) {
      const bucket = buckets.get(monthKey(new Date(r.createdAt)));
      if (!bucket) continue;
      bucket.usageCount += 1;
      bucket.discountedValue += r.amount;
      // An order can carry both a coupon and special-offer redemption —
      // count its value once towards generated revenue.
      bucket.orders.set(r.orderId, r.order?.total ?? 0);
    }
    const monthlyTrend = [...buckets.entries()].map(([month, b]) => ({
      month,
      usageCount: b.usageCount,
      discountedValue: round2(b.discountedValue),
      revenue: round2([...b.orders.values()].reduce((a, v) => a + v, 0))
    }));
    const current = monthlyTrend[monthlyTrend.length - 1];
    const previous = monthlyTrend[monthlyTrend.length - 2];
    const kpi = (key: 'usageCount' | 'discountedValue' | 'revenue') => ({
      value: current[key], previousMonth: previous[key], changePercent: percentChange(current[key], previous[key])
    });

    // --- Per-tool all-time stats ----------------------------------------
    const couponStats = new Map<string, ToolStats>(couponGroups.map((g: any) => [g.couponId, { usageCount: g._count._all, discountedValue: round2(g._sum.amount ?? 0), lastUsedAt: g._max.createdAt ?? null }]));
    const offerStats = new Map<string, ToolStats>(offerGroups.map((g: any) => [g.offerId, { usageCount: g._count._all, discountedValue: round2(g._sum.amount ?? 0), lastUsedAt: g._max.createdAt ?? null }]));
    const empty: ToolStats = { usageCount: 0, discountedValue: 0, lastUsedAt: null };

    const tools = [
      ...coupons.map((c: any) => ({
        kind: 'COUPON' as const, id: c.id, name: c.code, offerType: null,
        maxUses: c.maxUses ?? null, status: toolStatus(c, now), createdAt: c.createdAt,
        assignedToTeamMemberId: c.assignedToTeamMemberId ?? null, assignedTo: c.assignedToTeamMember ?? null,
        ...(couponStats.get(c.id) ?? empty)
      })),
      ...offers.map((o: any) => ({
        kind: 'OFFER' as const, id: o.id, name: o.name, offerType: o.type,
        maxUses: null, status: toolStatus(o, now), createdAt: o.createdAt,
        assignedToTeamMemberId: o.assignedToTeamMemberId ?? null, assignedTo: o.assignedToTeamMember ?? null,
        ...(offerStats.get(o.id) ?? empty)
      }))
    ];

    const activeCoupons = coupons.filter((c: any) => c.active).length;
    const activeOffers = offers.filter((o: any) => o.active).length;

    const topTools = [...tools]
      .sort((a, b) => b.usageCount - a.usageCount || b.discountedValue - a.discountedValue)
      .slice(0, TOP_TOOLS_LIMIT)
      .map(({ createdAt, assignedToTeamMemberId, assignedTo, ...rest }) => (isCompany ? { ...rest, assignedTo } : rest));

    const result: any = {
      accountType: user.accountType,
      period: { month: monthKey(thisMonthStart), from: thisMonthStart, to: nextMonthStart },
      kpis: {
        activeTools: {
          count: activeCoupons + activeOffers, coupons: activeCoupons, offers: activeOffers,
          // No historical snapshot of "active" exists, so month-over-month
          // for this KPI is expressed as tools created this calendar month.
          createdThisMonth: tools.filter(t => t.createdAt >= thisMonthStart && t.createdAt < nextMonthStart).length
        },
        monthlyUsage: kpi('usageCount'),
        discountedValue: kpi('discountedValue'),
        extraRevenue: kpi('revenue')
      },
      monthlyTrend,
      toolSummaries: {
        coupons: summarize(tools.filter(t => t.kind === 'COUPON').map(t => t.status)),
        offers: summarize(tools.filter(t => t.kind === 'OFFER').map(t => t.status))
      },
      topTools
    };

    if (isCompany) {
      const pendingCoupons = coupons.filter((c: any) => c.approvalStatus === 'PENDING').length;
      const pendingOffers = offers.filter((o: any) => o.approvalStatus === 'PENDING').length;
      const cap = user.marketingMonthlySpendCap ?? null;
      const consumed = current.discountedValue;

      const teamPerformance = (teamMembers as any[]).map(member => {
        const mine = tools.filter(t => t.assignedToTeamMemberId === member.id);
        return {
          teamMemberId: member.id, name: member.name, avatarUrl: member.avatarUrl ?? null,
          jobTitle: member.jobTitle, status: member.status,
          activeCoupons: mine.filter(t => t.kind === 'COUPON' && t.status === 'ACTIVE').length,
          activeOffers: mine.filter(t => t.kind === 'OFFER' && t.status === 'ACTIVE').length,
          totalTools: mine.length,
          usageCount: mine.reduce((a, t) => a + t.usageCount, 0),
          discountedValue: round2(mine.reduce((a, t) => a + t.discountedValue, 0))
        };
      }).sort((a, b) => b.discountedValue - a.discountedValue || b.usageCount - a.usageCount);

      result.company = {
        pendingApprovals: { count: pendingCoupons + pendingOffers, coupons: pendingCoupons, offers: pendingOffers },
        spendCap: {
          configured: cap !== null,
          cap,
          consumed,
          remaining: cap !== null ? round2(Math.max(cap - consumed, 0)) : null,
          percentUsed: cap !== null && cap > 0 ? Math.round((consumed / cap) * 1000) / 10 : null,
          resetsAt: nextMonthStart
        },
        teamPerformance
      };
    }

    return result;
  }

  // Company owner sets/clears the monthly marketing discount cap
  // (null = remove the cap). Strict PROVIDER_COMPANY gating is in the route.
  async updateSpendCap(providerId: string, cap: number | null) {
    const user = await prisma.user.findUnique({ where: { id: providerId }, select: { accountType: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);
    if (user.accountType !== AccountType.PROVIDER_COMPANY) throw new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403);
    const updated = await prisma.user.update({ where: { id: providerId }, data: { marketingMonthlySpendCap: cap }, select: { marketingMonthlySpendCap: true } });
    return { cap: updated.marketingMonthlySpendCap ?? null, configured: updated.marketingMonthlySpendCap !== null };
  }
}

export const marketingCenterService = new MarketingCenterService();
