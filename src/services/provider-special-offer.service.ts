import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { specialOfferShapeIssues } from '../dtos/special-offer.dto';
import { NOT_CANCELLED, StatsPaging, customerName, distinctOrderRevenue, pageMeta, round2, weeklyTrend } from './marketing-stats.util';

// Phase 6 — special offers. Structure deliberately mirrors
// provider-coupon.service.ts, including the company approval workflow.

// Same threshold number as provider-coupon.service.ts's
// COMPANY_APPROVAL_DISCOUNT_THRESHOLD. Special offers are always percentage
// discounts and have no usage-cap field (they apply automatically to every
// eligible order), so only the ">30%" leg of the coupon rule applies here.
const COMPANY_APPROVAL_DISCOUNT_THRESHOLD = 30;

function needsCompanyApproval(effective: { discountValue: number }) {
  return effective.discountValue > COMPANY_APPROVAL_DISCOUNT_THRESHOLD;
}

const BUNDLE_ONLY_FIELDS = ['primaryServiceId', 'beneficiaryServiceId', 'validityDays'] as const;
const DIRECT_ONLY_FIELDS = ['targetServiceId'] as const;

function format(offer: any) {
  return {
    id: offer.id, type: offer.type, name: offer.name,
    primaryServiceId: offer.primaryServiceId ?? null,
    beneficiaryServiceId: offer.beneficiaryServiceId ?? null,
    targetServiceId: offer.targetServiceId ?? null,
    discountValue: offer.discountValue, validityDays: offer.validityDays ?? null,
    startAt: offer.startAt, expiresAt: offer.expiresAt ?? null,
    badgeText: offer.badgeText, customerMessage: offer.customerMessage ?? null,
    internalNote: offer.internalNote ?? null,
    active: offer.active, usedCount: offer.usedCount,
    assignedToTeamMemberId: offer.assignedToTeamMemberId ?? null,
    createdByTeamMemberId: offer.createdByTeamMemberId ?? null,
    approvalStatus: offer.approvalStatus, rejectionReason: offer.rejectionReason ?? null,
    createdAt: offer.createdAt, updatedAt: offer.updatedAt
  };
}

function assertShape(value: any) {
  const issues = specialOfferShapeIssues(value);
  if (issues.length) throw new AppError(issues[0].message, 400);
}

export class ProviderSpecialOfferService {
  // Every referenced service (primary/beneficiary/target) must exist and
  // belong to this provider — same rule as coupons' validateServices.
  private async validateServices(providerId: string, serviceIds: (string | null | undefined)[]) {
    const uniqueServiceIds = [...new Set(serviceIds.filter((id): id is string => !!id))];
    if (!uniqueServiceIds.length) return;
    const services = await prisma.serviceCatalog.findMany({ where: { id: { in: uniqueServiceIds } }, select: { id: true, providerId: true } });
    if (services.length !== uniqueServiceIds.length) throw new AppError('إحدى الخدمات غير موجودة', 404);
    if (services.some(service => service.providerId !== providerId)) throw new AppError('الخدمة موجودة ولكنها لا تخص هذا المقدم، لا يمكنك إنشاء عرض عليها', 403);
  }

  // Tenant-isolation check, identical to provider-coupon.service.ts.
  private async validateTeamMember(companyOwnerId: string, teamMemberId: string) {
    const member = await prisma.companyTeamMember.findFirst({ where: { id: teamMemberId, companyOwnerId }, select: { id: true } });
    if (!member) throw new AppError('عضو الفريق غير موجود', 404);
  }

  async create(providerId: string, input: any) {
    assertShape(input);
    await this.validateServices(providerId, [input.primaryServiceId, input.beneficiaryServiceId, input.targetServiceId]);

    const user = await prisma.user.findUnique({ where: { id: providerId }, select: { accountType: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);

    if (input.assignedToTeamMemberId) await this.validateTeamMember(providerId, input.assignedToTeamMemberId);
    if (input.createdByTeamMemberId) await this.validateTeamMember(providerId, input.createdByTeamMemberId);

    const isCompany = user.accountType === AccountType.PROVIDER_COMPANY;
    const pending = isCompany && needsCompanyApproval({ discountValue: input.discountValue });
    const isBundle = input.type === 'BUNDLE';

    const offer = await prisma.specialOffer.create({ data: {
      providerId, type: input.type, name: input.name,
      primaryServiceId: isBundle ? input.primaryServiceId : null,
      beneficiaryServiceId: isBundle ? input.beneficiaryServiceId : null,
      validityDays: isBundle ? input.validityDays : null,
      targetServiceId: isBundle ? null : input.targetServiceId,
      discountValue: input.discountValue,
      startAt: input.startAt ?? new Date(), expiresAt: input.expiresAt ?? null,
      badgeText: input.badgeText, customerMessage: input.customerMessage ?? null,
      internalNote: input.internalNote ?? null,
      assignedToTeamMemberId: input.assignedToTeamMemberId ?? null,
      createdByTeamMemberId: input.createdByTeamMemberId ?? null,
      // Same outcome table as coupons: individual → always APPROVED;
      // company → PENDING + forced-inactive above the threshold.
      approvalStatus: !isCompany ? 'APPROVED' : (pending ? 'PENDING' : 'APPROVED'),
      active: pending ? false : true
    } });
    return format(offer);
  }

  async list(providerId: string) {
    const offers = await prisma.specialOffer.findMany({ where: { providerId }, orderBy: { createdAt: 'desc' } });
    return offers.map(format);
  }

  async get(providerId: string, id: string) {
    const offer = await prisma.specialOffer.findFirst({ where: { id, providerId } });
    if (!offer) throw new AppError('العرض غير موجود', 404);
    return format(offer);
  }

  async update(providerId: string, id: string, input: any) {
    const current = await prisma.specialOffer.findFirst({ where: { id, providerId } });
    if (!current) throw new AppError('العرض غير موجود', 404);

    const data: any = { ...input };

    // Switching type clears the previous type's fields unless the caller
    // explicitly supplied them (in which case the shape check below rejects
    // the contradictory combination).
    if (input.type && input.type !== current.type) {
      const stale = input.type === 'BUNDLE' ? DIRECT_ONLY_FIELDS : BUNDLE_ONLY_FIELDS;
      for (const field of stale) if (!(field in input)) data[field] = null;
    }

    const merged = { ...current, ...data };
    assertShape(merged);

    await this.validateServices(providerId, [data.primaryServiceId, data.beneficiaryServiceId, data.targetServiceId]);
    if (input.assignedToTeamMemberId) await this.validateTeamMember(providerId, input.assignedToTeamMemberId);

    const user = await prisma.user.findUnique({ where: { id: providerId }, select: { accountType: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);
    const isCompany = user.accountType === AccountType.PROVIDER_COMPANY;

    if (isCompany) {
      // Re-evaluate only when the discount itself changes (coupon parity).
      if ('discountValue' in input) {
        const pending = needsCompanyApproval({ discountValue: input.discountValue });
        data.approvalStatus = pending ? 'PENDING' : 'APPROVED';
        if (pending) data.active = false;
      } else if (current.approvalStatus === 'PENDING') {
        // Same guard as coupons: a PENDING offer can never be flipped live
        // through this endpoint by editing some unrelated field.
        data.active = false;
      }
    }

    const offer = await prisma.specialOffer.update({ where: { id }, data });
    return format(offer);
  }

  async remove(providerId: string, id: string) {
    const result = await prisma.specialOffer.updateMany({ where: { id, providerId }, data: { active: false } });
    if (!result.count) throw new AppError('العرض غير موجود', 404);
    return { id, active: false };
  }

  // Company-only approve/reject on a PENDING offer
  // (PATCH /provider/special-offers/:id/approval) — same semantics as
  // ProviderCouponService.decideApproval.
  async decideApproval(providerId: string, id: string, input: { decision: 'APPROVED' | 'REJECTED'; rejectionReason?: string | null }) {
    const offer = await prisma.specialOffer.findFirst({ where: { id, providerId } });
    if (!offer) throw new AppError('العرض غير موجود', 404);
    if (offer.approvalStatus !== 'PENDING') throw new AppError('لا يمكن اتخاذ قرار إلا على عرض بانتظار الموافقة', 400);

    const data: any = { approvalStatus: input.decision, rejectionReason: input.decision === 'REJECTED' ? (input.rejectionReason ?? null) : null };
    if (input.decision === 'APPROVED') {
      const expired = !!(offer.expiresAt && offer.expiresAt < new Date());
      data.active = !expired; // never silently reactivate an already-expired offer
    } else {
      data.active = false;
    }

    const updated = await prisma.specialOffer.update({ where: { id }, data });
    return format(updated);
  }

  // GET /provider/special-offers/summary — list-screen KPI
  // "إيراد إضافي من الباقات" (P-PR-041 / P-CO-MK-007). Same definition as the
  // marketing center's extraRevenue (sum of order totals, each order once,
  // CANCELLED excluded), scoped to this provider's BUNDLE offers only.
  async getSummary(providerId: string) {
    const rows = await prisma.specialOfferRedemption.findMany({
      where: { offer: { providerId, type: 'BUNDLE' }, order: NOT_CANCELLED },
      select: { orderId: true, order: { select: { total: true } } }
    });
    return {
      bundleExtraRevenue: distinctOrderRevenue(rows),
      bundleOrders: new Set(rows.map(r => r.orderId)).size,
      bundleRedemptions: rows.length
    };
  }

  // GET /provider/special-offers/:id/stats — per-offer stats for the details
  // screen (P-PR-041-تفاصيل / P-CO-MK-007-تفاصيل), for ANY offer of this
  // provider (not just the marketing center's top-10).
  async getStats(providerId: string, id: string, paging: StatsPaging = { page: 1, pageSize: 10 }, now: Date = new Date()) {
    const offer = await prisma.specialOffer.findFirst({
      where: { id, providerId },
      select: {
        id: true, type: true, primaryServiceId: true, beneficiaryServiceId: true, targetServiceId: true,
        validityDays: true, startAt: true, expiresAt: true
      }
    });
    if (!offer) throw new AppError('العرض غير موجود', 404);

    // The model the discount lands on: Y for a bundle, the target for a direct discount.
    const discountedServiceId = offer.type === 'BUNDLE' ? offer.beneficiaryServiceId : offer.targetServiceId;
    // If that service was deleted (FK SetNull) nothing can match: '' is never a uuid.
    const itemsOfDiscounted = { where: { serviceId: discountedServiceId ?? '' }, select: { serviceId: true, title: true, price: true } };

    const where = { offerId: id, order: NOT_CANCELLED };
    const [all, page] = await Promise.all([
      prisma.specialOfferRedemption.findMany({
        where,
        select: {
          amount: true, createdAt: true, userId: true, orderId: true,
          order: { select: { total: true, items: itemsOfDiscounted } }
        }
      }),
      prisma.specialOfferRedemption.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (paging.page - 1) * paging.pageSize,
        take: paging.pageSize,
        select: {
          id: true, amount: true, createdAt: true, orderId: true,
          order: { select: { orderNumber: true, status: true, subtotal: true, total: true, items: itemsOfDiscounted } },
          user: { select: { id: true, firstName: true, lastName: true } }
        }
      })
    ]);

    // Revenue of the discounted model itself (e.g. "إيراد الموقع المرتبط
    // بالباقة"): its line-item price on each redeemed order, each order once.
    const discountedItemByOrder = new Map<string, number>();
    for (const r of all as any[]) {
      const items = r.order?.items ?? [];
      discountedItemByOrder.set(r.orderId, items.reduce((a: number, it: any) => a + (it.price ?? 0), 0));
    }
    const lastUsedAt = all.reduce<Date | null>((max, r) => (!max || r.createdAt > max ? r.createdAt : max), null);
    const orders = new Set(all.map(r => r.orderId)).size;

    const result: any = {
      id: offer.id,
      type: offer.type,
      totals: {
        usageCount: all.length,
        discountedValue: round2(all.reduce((a, r) => a + r.amount, 0)),
        revenue: distinctOrderRevenue(all as any[]),
        discountedServiceRevenue: round2([...discountedItemByOrder.values()].reduce((a, v) => a + v, 0)),
        uniqueCustomers: new Set(all.map(r => r.userId)).size,
        averageOrderValue: orders ? round2(distinctOrderRevenue(all as any[]) / orders) : null,
        lastUsedAt
      },
      weeklyTrend: weeklyTrend(all, now),
      redemptions: {
        items: page.map((r: any) => {
          const item = r.order?.items?.[0] ?? null;
          return {
            redemptionId: r.id,
            orderId: r.orderId,
            orderNumber: r.order?.orderNumber ?? null,
            orderStatus: r.order?.status ?? null,
            customer: r.user ? { id: r.user.id, name: customerName(r.user) } : null,
            discountedItem: item ? { serviceId: item.serviceId, title: item.title, price: item.price } : null,
            orderValue: r.order?.subtotal ?? null,
            discountApplied: round2(r.amount),
            netValue: r.order?.total ?? null,
            createdAt: r.createdAt
          };
        }),
        ...pageMeta(paging, all.length)
      },
      bundle: null
    };

    if (offer.type === 'BUNDLE' && offer.primaryServiceId && offer.validityDays) {
      result.bundle = await this.bundleConversion(offer as any, all, now);
    }
    return result;
  }

  // "أثر الباقة على السلوك": customers who ordered the primary model X while
  // the offer was running, and how many of them then redeemed this offer
  // within validityDays of their FIRST such X order. SpecialOfferRedemption
  // stores (offerId, userId, orderId, amount, createdAt), so conversion is
  // matched per userId on redemption.createdAt.
  private async bundleConversion(
    offer: { primaryServiceId: string; validityDays: number; startAt: Date; expiresAt: Date | null },
    redemptions: { userId: string; createdAt: Date }[],
    now: Date
  ) {
    const windowEnd = offer.expiresAt && offer.expiresAt < now ? offer.expiresAt : now;
    const primaryItems = await prisma.orderItem.findMany({
      where: { serviceId: offer.primaryServiceId, order: { ...NOT_CANCELLED, createdAt: { gte: offer.startAt, lte: windowEnd } } },
      select: { order: { select: { userId: true, createdAt: true } } }
    });

    const firstPrimaryOrder = new Map<string, Date>();
    for (const it of primaryItems as any[]) {
      const { userId, createdAt } = it.order;
      const prev = firstPrimaryOrder.get(userId);
      if (!prev || createdAt < prev) firstPrimaryOrder.set(userId, createdAt);
    }

    const windowMs = offer.validityDays * 24 * 60 * 60 * 1000;
    let converted = 0;
    for (const [userId, first] of firstPrimaryOrder) {
      const start = first.getTime();
      if (redemptions.some(r => r.userId === userId && r.createdAt.getTime() >= start && r.createdAt.getTime() <= start + windowMs)) converted += 1;
    }

    const primaryCustomers = firstPrimaryOrder.size;
    return {
      primaryServiceId: offer.primaryServiceId,
      validityDays: offer.validityDays,
      primaryCustomers,
      convertedCustomers: converted,
      // Percentage (one decimal); null when nobody ordered X yet (no baseline).
      conversionRate: primaryCustomers ? Math.round((converted / primaryCustomers) * 1000) / 10 : null
    };
  }
}

export const providerSpecialOfferService = new ProviderSpecialOfferService();
