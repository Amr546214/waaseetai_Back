import { LogCategory, LogStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError, fieldError } from '../utils/app-error';
import { StatsPaging, customerName, pageMeta, round2 } from './marketing-stats.util';

// Admin oversight of provider coupons + special offers. Coupons/offers are
// CREATED by providers (provider-coupon.service.ts / provider-special-offer
// .service.ts); the admin side lists them, shows real usage, and can switch a
// coupon off/on (with a mandatory reason on deactivate, audit-logged).
// Special offers are read-only here.

export type CouponStatus = 'active' | 'expired' | 'exhausted' | 'inactive';
export const COUPON_STATUSES: CouponStatus[] = ['active', 'expired', 'exhausted', 'inactive'];

const providerSelect = { id: true, firstName: true, lastName: true, email: true, accountType: true } as const;
const providerName = (u: any) => (u ? customerName(u) : null);

// Single source of truth for the status label; precedence: expired >
// exhausted > inactive > active (an expired coupon that is still flagged
// active=true must read "expired", never "active").
export function couponStatus(c: { active: boolean; expiresAt: Date | null; maxUses: number | null; usedCount: number }, now = new Date()): CouponStatus {
  if (c.expiresAt && c.expiresAt <= now) return 'expired';
  if (c.maxUses !== null && c.maxUses !== undefined && c.usedCount >= c.maxUses) return 'exhausted';
  if (!c.active) return 'inactive';
  return 'active';
}

function couponStatusWhere(status: CouponStatus | undefined, now: Date): any {
  const notExpired = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const notExhausted = { OR: [{ maxUses: null }, { usedCount: { lt: (prisma as any).coupon.fields?.maxUses } }] };
  switch (status) {
    case 'expired': return { expiresAt: { lte: now } };
    case 'exhausted': return { AND: [notExpired, { maxUses: { not: null } }, { usedCount: { gte: (prisma as any).coupon.fields?.maxUses } }] };
    case 'inactive': return { AND: [notExpired, notExhausted, { active: false }] };
    case 'active': return { AND: [notExpired, notExhausted, { active: true }] };
    default: return {};
  }
}

function formatCoupon(c: any, now: Date) {
  return {
    id: c.id, code: c.code,
    provider: c.provider ? { id: c.provider.id, name: providerName(c.provider), email: c.provider.email, accountType: c.provider.accountType } : null,
    discountType: c.discountType, discountValue: c.discountValue, minimumAmount: c.minimumAmount, maxDiscount: c.maxDiscount,
    maxUses: c.maxUses, usedCount: c.usedCount, maxUsesPerUser: c.maxUsesPerUser,
    active: c.active, status: couponStatus(c, now), approvalStatus: c.approvalStatus, rejectionReason: c.rejectionReason ?? null,
    startAt: c.startAt, expiresAt: c.expiresAt,
    // empty = applies to all of the provider's services
    services: (c.services ?? []).map((s: any) => ({ id: s.serviceId, title: s.service?.title ?? null })),
    excludedServiceIds: c.excludedServiceIds ?? [],
    createdAt: c.createdAt, updatedAt: c.updatedAt
  };
}

const couponInclude = {
  provider: { select: providerSelect },
  services: { select: { serviceId: true, service: { select: { title: true } } } }
} as const;

export interface AdminCouponListQuery { status?: string; providerId?: string; q?: string }

export class AdminCouponsService {
  async list(query: AdminCouponListQuery, paging: StatsPaging, now = new Date()) {
    if (query.status && !COUPON_STATUSES.includes(query.status as CouponStatus)) throw new AppError('حالة الكوبون غير صالحة', 400);
    const and: any[] = [couponStatusWhere(query.status as CouponStatus | undefined, now)];
    if (query.providerId) and.push({ providerId: query.providerId });
    if (query.q?.trim()) and.push({ code: { contains: query.q.trim(), mode: 'insensitive' } });
    const where = { AND: and };

    const [items, total, redemptionAgg] = await Promise.all([
      prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize, include: couponInclude }),
      prisma.coupon.count({ where }),
      prisma.couponRedemption.aggregate({ where: { order: { status: { not: 'CANCELLED' } } }, _sum: { amount: true }, _count: { _all: true } })
    ]);
    return {
      items: items.map((c: any) => formatCoupon(c, now)),
      summary: { totalRedemptions: redemptionAgg._count._all, totalDiscountGiven: round2(redemptionAgg._sum.amount ?? 0) },
      ...pageMeta(paging, total)
    };
  }

  async get(id: string, now = new Date()) {
    const coupon = await prisma.coupon.findUnique({ where: { id }, include: couponInclude });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);
    const [redemptions, redemptionCount] = await Promise.all([
      prisma.couponRedemption.findMany({
        where: { couponId: id }, orderBy: { createdAt: 'desc' }, take: 50,
        select: {
          id: true, amount: true, createdAt: true, orderId: true,
          order: { select: { orderNumber: true, status: true, subtotal: true, total: true } },
          user: { select: { id: true, firstName: true, lastName: true } }
        }
      }),
      prisma.couponRedemption.count({ where: { couponId: id } })
    ]);
    return {
      ...formatCoupon(coupon, now),
      internalNote: (coupon as any).internalNote ?? null,
      redemptionCount,
      redemptions: redemptions.map((r: any) => ({
        id: r.id, orderId: r.orderId, orderNumber: r.order?.orderNumber ?? null, orderStatus: r.order?.status ?? null,
        customer: r.user ? { id: r.user.id, name: customerName(r.user) } : null,
        orderValue: r.order?.subtotal ?? null, discountApplied: round2(r.amount), netValue: r.order?.total ?? null, createdAt: r.createdAt
      }))
    };
  }

  async setActive(adminId: string, id: string, input: { active: boolean; reason?: string | null }, now = new Date()) {
    const reason = input.reason?.trim() || '';
    if (!input.active && !reason) throw fieldError('reason', 'يجب توضيح سبب إيقاف الكوبون');
    const coupon = await prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);
    if (coupon.active === input.active) throw new AppError(input.active ? 'الكوبون مفعّل بالفعل' : 'الكوبون موقوف بالفعل', 409);
    if (input.active) {
      // Reactivating must never bypass the expiry / usage-cap / company-approval rules.
      if (coupon.approvalStatus === 'PENDING' || coupon.approvalStatus === 'REJECTED') throw new AppError('لا يمكن تفعيل كوبون بانتظار موافقة الشركة أو مرفوض', 400);
      const st = couponStatus({ ...coupon, active: true }, now);
      if (st === 'expired') throw new AppError('لا يمكن تفعيل كوبون منتهي الصلاحية', 400);
      if (st === 'exhausted') throw new AppError('لا يمكن تفعيل كوبون استُنفد عدد استخداماته', 400);
    }

    return prisma.$transaction(async tx => {
      const updated = await tx.coupon.update({ where: { id }, data: { active: input.active }, include: couponInclude });
      await tx.accountAuditLog.create({
        data: {
          userId: coupon.providerId ?? adminId,
          category: LogCategory.SYSTEM_AUDIT,
          title: input.active ? 'إعادة تفعيل كوبون من الإدارة' : 'إيقاف كوبون من الإدارة',
          actionText: `${input.active ? 'أعادت' : 'أوقفت'} الإدارة الكوبون ${coupon.code}`,
          status: LogStatus.COMPLETED,
          source: 'ADMIN',
          eventType: input.active ? 'COUPON_ADMIN_REACTIVATED' : 'COUPON_ADMIN_DEACTIVATED',
          severity: 'INFO',
          summary: reason || null,
          metaData: { couponId: id, code: coupon.code, adminId, reason: reason || null },
          beforeData: { active: coupon.active },
          afterData: { active: input.active }
        }
      });
      return formatCoupon(updated, now);
    });
  }

  // ---- special offers (read-only) ----
  async listSpecialOffers(query: { status?: string; providerId?: string; q?: string; type?: string }, paging: StatsPaging, now = new Date()) {
    const allowed = ['active', 'expired', 'inactive'];
    if (query.status && !allowed.includes(query.status)) throw new AppError('حالة العرض غير صالحة', 400);
    if (query.type && !['BUNDLE', 'DIRECT_DISCOUNT'].includes(query.type)) throw new AppError('نوع العرض غير صالح', 400);
    const notExpired = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    const and: any[] = [];
    if (query.status === 'expired') and.push({ expiresAt: { lte: now } });
    if (query.status === 'inactive') and.push(notExpired, { active: false });
    if (query.status === 'active') and.push(notExpired, { active: true });
    if (query.providerId) and.push({ providerId: query.providerId });
    if (query.type) and.push({ type: query.type });
    if (query.q?.trim()) and.push({ name: { contains: query.q.trim(), mode: 'insensitive' } });
    const where = { AND: and };

    const [items, total] = await Promise.all([
      prisma.specialOffer.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize, include: offerInclude }),
      prisma.specialOffer.count({ where })
    ]);
    return { items: items.map((o: any) => formatOffer(o, now)), ...pageMeta(paging, total) };
  }

  async getSpecialOffer(id: string, now = new Date()) {
    const offer = await prisma.specialOffer.findUnique({ where: { id }, include: offerInclude });
    if (!offer) throw new AppError('العرض غير موجود', 404);
    const [redemptions, redemptionCount] = await Promise.all([
      prisma.specialOfferRedemption.findMany({
        where: { offerId: id }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, amount: true, createdAt: true, orderId: true, order: { select: { orderNumber: true, status: true } }, user: { select: { id: true, firstName: true, lastName: true } } }
      }),
      prisma.specialOfferRedemption.count({ where: { offerId: id } })
    ]);
    return {
      ...formatOffer(offer, now),
      customerMessage: (offer as any).customerMessage ?? null,
      internalNote: (offer as any).internalNote ?? null,
      redemptionCount,
      redemptions: redemptions.map((r: any) => ({
        id: r.id, orderId: r.orderId, orderNumber: r.order?.orderNumber ?? null, orderStatus: r.order?.status ?? null,
        customer: r.user ? { id: r.user.id, name: customerName(r.user) } : null, discountApplied: round2(r.amount), createdAt: r.createdAt
      }))
    };
  }
}

const svcSel = { select: { id: true, title: true } } as const;
const offerInclude = {
  provider: { select: providerSelect },
  primaryService: svcSel, beneficiaryService: svcSel, targetService: svcSel
} as const;

function formatOffer(o: any, now: Date) {
  const status: 'expired' | 'inactive' | 'active' = o.expiresAt && o.expiresAt <= now ? 'expired' : (!o.active ? 'inactive' : 'active');
  return {
    id: o.id, type: o.type, name: o.name, badgeText: o.badgeText,
    provider: o.provider ? { id: o.provider.id, name: providerName(o.provider), email: o.provider.email, accountType: o.provider.accountType } : null,
    discountValue: o.discountValue, validityDays: o.validityDays ?? null,
    primaryService: o.primaryService ?? null, beneficiaryService: o.beneficiaryService ?? null, targetService: o.targetService ?? null,
    active: o.active, status, approvalStatus: o.approvalStatus, rejectionReason: o.rejectionReason ?? null,
    usedCount: o.usedCount, startAt: o.startAt, expiresAt: o.expiresAt, createdAt: o.createdAt
  };
}

export const adminCouponsService = new AdminCouponsService();
