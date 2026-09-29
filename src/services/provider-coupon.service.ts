import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { NOT_CANCELLED, StatsPaging, customerName, distinctOrderRevenue, pageMeta, round2, weeklyTrend } from './marketing-stats.util';

const providerCouponInclude = { services: { select: { serviceId: true } } } as const;

// Phase 5 — company approval threshold: a PROVIDER_COMPANY coupon needs the
// account owner's sign-off (approvalStatus = PENDING, forced inactive) when
// it's either an uncapped-percentage-style risk (>30%) or has no usage cap
// at all (maxUses null/undefined = unlimited redemptions). Anything below
// that is auto-approved, matching today's individual-provider behavior.
const COMPANY_APPROVAL_DISCOUNT_THRESHOLD = 30;

function needsCompanyApproval(effective: { discountType: string; discountValue: number; maxUses: number | null | undefined }) {
  const uncappedUses = effective.maxUses === null || effective.maxUses === undefined;
  const highDiscount = effective.discountType === 'percentage' && effective.discountValue > COMPANY_APPROVAL_DISCOUNT_THRESHOLD;
  return uncappedUses || highDiscount;
}

function format(coupon: any) {
  return {
    id: coupon.id, code: coupon.code, discountType: coupon.discountType,
    discountValue: coupon.discountValue, minimumAmount: coupon.minimumAmount,
    maxDiscount: coupon.maxDiscount, maxUses: coupon.maxUses,
    usedCount: coupon.usedCount, maxUsesPerUser: coupon.maxUsesPerUser,
    active: coupon.active, startAt: coupon.startAt, expiresAt: coupon.expiresAt,
    serviceIds: coupon.services.map((item: any) => item.serviceId),
    excludedServiceIds: coupon.excludedServiceIds ?? [],
    internalNote: coupon.internalNote ?? null,
    assignedToTeamMemberId: coupon.assignedToTeamMemberId ?? null,
    createdByTeamMemberId: coupon.createdByTeamMemberId ?? null,
    approvalStatus: coupon.approvalStatus, rejectionReason: coupon.rejectionReason ?? null,
    createdAt: coupon.createdAt, updatedAt: coupon.updatedAt
  };
}

export class ProviderCouponService {
  private async validateServices(providerId: string, serviceIds: string[]) {
    const uniqueServiceIds = [...new Set(serviceIds)];
    const services = await prisma.serviceCatalog.findMany({ where: { id: { in: uniqueServiceIds } }, select: { id: true, providerId: true } });
    if (services.length !== uniqueServiceIds.length) throw new AppError('إحدى الخدمات غير موجودة', 404);
    if (services.some(service => service.providerId !== providerId)) throw new AppError('الخدمة موجودة ولكنها لا تخص هذا المقدم، لا يمكنك إنشاء كوبون عليها', 403);
  }

  // Tenant-isolation check, same pattern as company-team.service.ts: a
  // team member id must belong to this exact company owner's own roster.
  private async validateTeamMember(companyOwnerId: string, teamMemberId: string) {
    const member = await prisma.companyTeamMember.findFirst({ where: { id: teamMemberId, companyOwnerId }, select: { id: true } });
    if (!member) throw new AppError('عضو الفريق غير موجود', 404);
  }

  async create(providerId: string, input: any) {
    await this.validateServices(providerId, input.serviceIds);
    const existing = await prisma.coupon.findUnique({ where: { code: input.code } });
    if (existing) throw new AppError('كود الكوبون مستعمل من قبل', 409);

    const user = await prisma.user.findUnique({ where: { id: providerId }, select: { accountType: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);

    if (input.assignedToTeamMemberId) await this.validateTeamMember(providerId, input.assignedToTeamMemberId);
    if (input.createdByTeamMemberId) await this.validateTeamMember(providerId, input.createdByTeamMemberId);

    const isCompany = user.accountType === AccountType.PROVIDER_COMPANY;
    const pending = isCompany && needsCompanyApproval({ discountType: input.discountType, discountValue: input.discountValue, maxUses: input.maxUses ?? null });

    const coupon = await prisma.coupon.create({ data: {
      providerId, code: input.code, discountType: input.discountType,
      discountValue: input.discountValue, minimumAmount: input.minimumAmount ?? null,
      maxDiscount: input.maxDiscount ?? null, maxUses: input.maxUses ?? null,
      maxUsesPerUser: input.maxUsesPerUser ?? 1, startAt: input.startAt ?? new Date(),
      expiresAt: input.expiresAt ?? null,
      excludedServiceIds: input.excludedServiceIds ?? [],
      internalNote: input.internalNote ?? null,
      assignedToTeamMemberId: input.assignedToTeamMemberId ?? null,
      createdByTeamMemberId: input.createdByTeamMemberId ?? null,
      // Individual providers: always auto-approved (unchanged behavior).
      // Company providers: PENDING + forced-inactive above the threshold,
      // otherwise auto-approved just like an individual.
      approvalStatus: !isCompany ? 'APPROVED' : (pending ? 'PENDING' : 'APPROVED'),
      active: pending ? false : true,
      services: { create: input.serviceIds.map((serviceId: string) => ({ serviceId })) }
    }, include: providerCouponInclude });
    return format(coupon);
  }

  async list(providerId: string) {
    const coupons = await prisma.coupon.findMany({ where: { providerId }, orderBy: { createdAt: 'desc' }, include: providerCouponInclude });
    return coupons.map(format);
  }

  async get(providerId: string, id: string) {
    const coupon = await prisma.coupon.findFirst({ where: { id, providerId }, include: providerCouponInclude });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);
    return format(coupon);
  }

  async update(providerId: string, id: string, input: any) {
    const current = await prisma.coupon.findFirst({ where: { id, providerId } });
    if (!current) throw new AppError('الكوبون غير موجود', 404);
    if (input.serviceIds) await this.validateServices(providerId, input.serviceIds);
    if (input.assignedToTeamMemberId) await this.validateTeamMember(providerId, input.assignedToTeamMemberId);

    const user = await prisma.user.findUnique({ where: { id: providerId }, select: { accountType: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);
    const isCompany = user.accountType === AccountType.PROVIDER_COMPANY;

    const { serviceIds, ...data } = input;

    if (isCompany) {
      // Only re-evaluate the approval threshold when discount/usage-cap
      // terms actually change — matches "on create (and on update if
      // discount/maxUses change)". `'maxUses' in input` (not `input.maxUses`)
      // so an explicit `maxUses: null` (removing the cap) is distinguished
      // from the field simply being absent from this particular update.
      const touchesThresholdFields = ('discountValue' in input) || ('maxUses' in input) || ('discountType' in input);
      if (touchesThresholdFields) {
        const effective = {
          discountType: input.discountType ?? current.discountType,
          discountValue: input.discountValue ?? current.discountValue,
          maxUses: ('maxUses' in input) ? input.maxUses : current.maxUses
        };
        const pending = needsCompanyApproval(effective);
        data.approvalStatus = pending ? 'PENDING' : 'APPROVED';
        if (pending) data.active = false;
      } else if (current.approvalStatus === 'PENDING') {
        // Closes an otherwise-exploitable gap: without this, a company
        // owner could flip `active: true` via this same endpoint while the
        // coupon is still PENDING (without touching discount/maxUses at
        // all) and bypass the approval workflow entirely. A PENDING coupon
        // must genuinely never be live regardless of what else is edited.
        data.active = false;
      }
    }

    const coupon = await prisma.$transaction(async tx => {
      if (serviceIds) {
        await tx.couponService.deleteMany({ where: { couponId: id } });
        await tx.couponService.createMany({ data: serviceIds.map((serviceId: string) => ({ couponId: id, serviceId })) });
      }
      return tx.coupon.update({ where: { id }, data, include: providerCouponInclude });
    });
    return format(coupon);
  }

  async remove(providerId: string, id: string) {
    const result = await prisma.coupon.updateMany({ where: { id, providerId }, data: { active: false } });
    if (!result.count) throw new AppError('الكوبون غير موجود', 404);
    return { id, active: false };
  }

  // Phase 5 — company-only approve/reject on a PENDING coupon
  // (PATCH /provider/coupons/:id/approval). `providerId` here is the
  // authenticated company owner — coupons are attributed to the company
  // owner's own User.id as providerId, exactly like individual providers
  // (confirmed via create() above), so the same `{ id, providerId }` lookup
  // used everywhere else in this service also naturally enforces that this
  // company can only decide on its own coupons.
  async decideApproval(providerId: string, id: string, input: { decision: 'APPROVED' | 'REJECTED'; rejectionReason?: string | null }) {
    const coupon = await prisma.coupon.findFirst({ where: { id, providerId } });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);
    if (coupon.approvalStatus !== 'PENDING') throw new AppError('لا يمكن اتخاذ قرار إلا على كوبون بانتظار الموافقة', 400);

    const data: any = { approvalStatus: input.decision, rejectionReason: input.decision === 'REJECTED' ? (input.rejectionReason ?? null) : null };
    if (input.decision === 'APPROVED') {
      const now = new Date();
      const expired = !!(coupon.expiresAt && coupon.expiresAt < now);
      data.active = !expired; // never silently reactivate an already-expired coupon
    } else {
      data.active = false;
    }

    const updated = await prisma.coupon.update({ where: { id }, data, include: providerCouponInclude });
    return format(updated);
  }

  // GET /provider/coupons/:id/stats — per-coupon usage stats for the
  // details screen (P-PR-040-تفاصيل / P-CO-MK-006-تفاصيل), for ANY coupon of
  // this provider (not just the marketing center's top-10). Same data rules
  // as marketing-center.service.ts: CANCELLED orders excluded.
  async getStats(providerId: string, id: string, paging: StatsPaging = { page: 1, pageSize: 10 }, now: Date = new Date()) {
    const coupon = await prisma.coupon.findFirst({ where: { id, providerId }, select: { id: true, maxUses: true } });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);

    const where = { couponId: id, order: NOT_CANCELLED };
    const [all, page] = await Promise.all([
      prisma.couponRedemption.findMany({
        where,
        select: { amount: true, createdAt: true, userId: true, orderId: true, order: { select: { subtotal: true, total: true } } }
      }),
      prisma.couponRedemption.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (paging.page - 1) * paging.pageSize,
        take: paging.pageSize,
        select: {
          id: true, amount: true, createdAt: true, orderId: true,
          order: { select: { orderNumber: true, status: true, subtotal: true, total: true } },
          user: { select: { id: true, firstName: true, lastName: true } }
        }
      })
    ]);

    const usesPerUser = new Map<string, number>();
    for (const r of all) usesPerUser.set(r.userId, (usesPerUser.get(r.userId) ?? 0) + 1);
    const grossOrderValue = all.reduce((a, r) => a + (r.order?.subtotal ?? 0), 0);
    const lastUsedAt = all.reduce<Date | null>((max, r) => (!max || r.createdAt > max ? r.createdAt : max), null);

    return {
      id: coupon.id,
      totals: {
        usageCount: all.length,
        maxUses: coupon.maxUses ?? null,
        discountedValue: round2(all.reduce((a, r) => a + r.amount, 0)),
        revenue: distinctOrderRevenue(all),
        uniqueCustomers: usesPerUser.size,
        repeatCustomers: [...usesPerUser.values()].filter(n => n > 1).length,
        // "متوسط قيمة الطلب بالكوبون — قبل الخصم" → order subtotal.
        averageOrderValue: all.length ? round2(grossOrderValue / all.length) : null,
        lastUsedAt
      },
      weeklyTrend: weeklyTrend(all, now),
      redemptions: {
        items: page.map((r: any) => ({
          redemptionId: r.id,
          orderId: r.orderId,
          orderNumber: r.order?.orderNumber ?? null,
          orderStatus: r.order?.status ?? null,
          customer: r.user ? { id: r.user.id, name: customerName(r.user) } : null,
          orderValue: r.order?.subtotal ?? null,
          discountApplied: round2(r.amount),
          netValue: r.order?.total ?? null,
          createdAt: r.createdAt
        })),
        ...pageMeta(paging, all.length)
      }
    };
  }
}

export const providerCouponService = new ProviderCouponService();
