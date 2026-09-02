import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

const providerCouponInclude = { services: { select: { serviceId: true } } } as const;

function format(coupon: any) {
  return {
    id: coupon.id, code: coupon.code, discountType: coupon.discountType,
    discountValue: coupon.discountValue, minimumAmount: coupon.minimumAmount,
    maxDiscount: coupon.maxDiscount, maxUses: coupon.maxUses,
    usedCount: coupon.usedCount, maxUsesPerUser: coupon.maxUsesPerUser,
    active: coupon.active, startAt: coupon.startAt, expiresAt: coupon.expiresAt,
    serviceIds: coupon.services.map((item: any) => item.serviceId),
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

  async create(providerId: string, input: any) {
    await this.validateServices(providerId, input.serviceIds);
    const existing = await prisma.coupon.findUnique({ where: { code: input.code } });
    if (existing) throw new AppError('كود الكوبون مستعمل من قبل', 409);
    const coupon = await prisma.coupon.create({ data: {
      providerId, code: input.code, discountType: input.discountType,
      discountValue: input.discountValue, minimumAmount: input.minimumAmount ?? null,
      maxDiscount: input.maxDiscount ?? null, maxUses: input.maxUses ?? null,
      maxUsesPerUser: input.maxUsesPerUser ?? 1, startAt: input.startAt ?? new Date(),
      expiresAt: input.expiresAt ?? null, services: { create: input.serviceIds.map((serviceId: string) => ({ serviceId })) }
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
    const { serviceIds, ...data } = input;
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
}

export const providerCouponService = new ProviderCouponService();
