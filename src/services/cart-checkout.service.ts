import crypto from 'crypto';
import { ContractStatus, EscrowStatus, OrderStatus, OtpType, ProjectStageStatus, ProjectStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';

const serviceWhere = { status: { in: ['PUBLISHED', 'APPROVED'] as any } };

/**
 * DEV/TEST ONLY — Allows wallet checkout to proceed even when balance is insufficient.
 * Honored regardless of NODE_ENV (since dev backend may use NODE_ENV=production).
 * To enable: set ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE=true in .env
 * To disable: set to false or remove the flag. NEVER commit this as true.
 */
function isTestCheckoutBypassEnabled(): boolean {
  return process.env.ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE === 'true';
}

function personName(user: { firstName: string; lastName: string }) {
  return `${user.firstName} ${user.lastName}`.trim();
}

function initials(user: { firstName: string; lastName: string }) {
  return `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase();
}

const serviceInclude = {
  provider: { select: { id: true, firstName: true, lastName: true, currentLevel: true, providerProfile: { select: { isVerified: true } } } },
  specialty: { select: { name: true, nameAr: true, slug: true } }
} as const;

export class CartCheckoutService {
  private paymentOtpContext(orderId: string, paymentReference: string, paymentMethod: string) {
    return { purpose: 'checkout_payment', orderId, paymentReference, paymentMethod };
  }

  private maskEmail(email?: string | null) {
    return email ? email.replace(/^(.{2}).*(@.*)$/, '$1••••$2') : 'البريد الإلكتروني المسجل';
  }

  private async getOrCreateCart(userId: string) {
    return prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: { items: { orderBy: { addedAt: 'asc' }, include: { service: { include: serviceInclude } } } }
    });
  }

  private formatCartItem(item: any) {
    const service = item.service;
    const provider = service.provider;
    return {
      id: item.id,
      modelId: service.id,
      title: service.title,
      category: service.specialty?.nameAr || service.specialty?.name || '',
      categorySlug: service.specialty?.slug || '',
      specializationSlug: service.specialty?.slug || '',
      totalAmount: Number(service.totalAmount),
      totalDays: service.totalDays,
      aiScore: service.aiScore || 0,
      level: provider.currentLevel || 'مستكشف - المستوى 1',
      provider: { id: provider.id, name: personName(provider), initials: initials(provider), isVerified: Boolean(provider.providerProfile?.isVerified) },
      packageName: item.packageName,
      addedAt: item.addedAt.toISOString(),
      savedForLater: item.savedForLater
    };
  }

  async getCart(userId: string) {
    const cart = await this.getOrCreateCart(userId);
    return { id: cart.id, items: cart.items.map(item => this.formatCartItem(item)) };
  }

  async addItem(userId: string, input: { modelId: string; packageId?: string; savedForLater?: boolean }) {
    const service = await prisma.serviceCatalog.findFirst({ where: { id: input.modelId, ...serviceWhere } });
    if (!service) throw new AppError('الخدمة غير موجودة أو غير متاحة للطلب', 404);
    const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    await prisma.cartItem.upsert({
      where: { cartId_serviceId: { cartId: cart.id, serviceId: service.id } },
      create: { cartId: cart.id, serviceId: service.id, packageId: input.packageId || 'basic', savedForLater: input.savedForLater ?? false },
      update: { packageId: input.packageId || 'basic', savedForLater: input.savedForLater ?? false }
    });
    return this.getCart(userId);
  }

  async updateItem(userId: string, itemId: string, input: { packageId?: string; savedForLater?: boolean }) {
    const item = await prisma.cartItem.findFirst({ where: { id: itemId, cart: { userId } } });
    if (!item) throw new AppError('عنصر السلة غير موجود', 404);
    await prisma.cartItem.update({ where: { id: itemId }, data: { packageId: input.packageId, savedForLater: input.savedForLater } });
    return this.getCart(userId);
  }

  async removeItem(userId: string, itemId: string) {
    const item = await prisma.cartItem.findFirst({ where: { id: itemId, cart: { userId } } });
    if (!item) throw new AppError('عنصر السلة غير موجود', 404);
    await prisma.cartItem.delete({ where: { id: itemId } });
    return this.getCart(userId);
  }

  async sync(userId: string, items: Array<{ modelId: string; packageId?: string; savedForLater?: boolean }>) {
    const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    const services = await prisma.serviceCatalog.findMany({ where: { id: { in: items.map(item => item.modelId) }, ...serviceWhere }, select: { id: true } });
    const available = new Set(services.map(service => service.id));
    const validItems = items.filter(item => available.has(item.modelId));
    await prisma.$transaction(async tx => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      if (validItems.length) await tx.cartItem.createMany({ data: validItems.map(item => ({ cartId: cart.id, serviceId: item.modelId, packageId: item.packageId || 'basic', savedForLater: item.savedForLater ?? false })) });
    });
    return this.getCart(userId);
  }

  private async calculateCoupon(code: string, modelIds: string[], userId?: string) {
    const coupon = await prisma.coupon.findFirst({ where: { code: code.toUpperCase(), active: true }, include: { services: { select: { serviceId: true } } } });
    const now = new Date();
    if (!coupon || coupon.startAt > now || (coupon.expiresAt && coupon.expiresAt < now) || (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses)) throw new AppError('كوبون غير صالح', 400);
    if (userId && (await prisma.couponRedemption.count({ where: { couponId: coupon.id, userId } })) >= coupon.maxUsesPerUser) throw new AppError('لقد استعملت هذا الكوبون من قبل', 400);
    const services = await prisma.serviceCatalog.findMany({ where: { id: { in: modelIds }, ...serviceWhere }, select: { id: true, totalAmount: true } });
    if (services.length !== modelIds.length) throw new AppError('كوبون غير صالح', 400);
    const eligibleIds = new Set(coupon.services.map(item => item.serviceId));
    const eligibleServices = coupon.services.length ? services.filter(service => eligibleIds.has(service.id)) : services;
    const subtotal = eligibleServices.reduce((sum, service) => sum + Number(service.totalAmount), 0);
    if (!subtotal || (coupon.minimumAmount !== null && subtotal < coupon.minimumAmount)) throw new AppError('الخدمات لا تستوفي شروط الكوبون', 400);
    let discountAmount = coupon.discountType === 'percentage' ? subtotal * coupon.discountValue / 100 : Math.min(subtotal, coupon.discountValue);
    if (coupon.maxDiscount !== null) discountAmount = Math.min(discountAmount, coupon.maxDiscount);
    return { coupon, subtotal, discountAmount: Number(discountAmount.toFixed(2)) };
  }

  async validateCoupon(userId: string, input: { code: string; items: Array<{ modelId: string; totalAmount: number }> }) {
    const result = await this.calculateCoupon(input.code, input.items.map(item => item.modelId), userId);
    return { code: result.coupon.code, discountType: result.coupon.discountType, discountValue: result.coupon.discountValue, discountAmount: result.discountAmount };
  }

  async createOrder(userId: string, input: { items: Array<{ modelId: string; packageId?: string }>; couponCode?: string | null }) {
    const ids = input.items.map(item => item.modelId);
    if (new Set(ids).size !== ids.length) throw new AppError('لا يمكن تكرار الخدمة داخل الطلب', 400);
    const services = await prisma.serviceCatalog.findMany({ where: { id: { in: ids }, ...serviceWhere }, include: serviceInclude });
    if (services.length !== ids.length) throw new AppError('إحدى الخدمات غير موجودة أو غير متاحة للطلب', 400);
    const byId = new Map(services.map(service => [service.id, service]));
    const subtotal = services.reduce((sum, service) => sum + Number(service.totalAmount), 0);
    let discount = 0; let couponId: string | undefined; let couponCode: string | undefined; let couponDiscountType: string | undefined; let couponDiscountValue: number | undefined;
    if (input.couponCode) { const calculated = await this.calculateCoupon(input.couponCode, ids, userId); discount = calculated.discountAmount; couponId = calculated.coupon.id; couponCode = calculated.coupon.code; couponDiscountType = calculated.coupon.discountType; couponDiscountValue = calculated.coupon.discountValue; }
    const order = await prisma.$transaction(async tx => {
      const count = await tx.order.count();
      const orderNumber = `WS-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
      const created = await tx.order.create({ data: { userId, orderNumber, status: OrderStatus.PENDING_PAYMENT, subtotal, discount, total: Number((subtotal - discount).toFixed(2)), couponId, couponCode, couponDiscountType, couponDiscountValue, items: { create: input.items.map(item => { const service: any = byId.get(item.modelId)!; const provider = service.provider; return { serviceId: service.id, modelId: service.id, title: service.title, providerId: provider.id, providerName: personName(provider), initials: initials(provider), isVerified: Boolean(provider.providerProfile?.isVerified), packageId: item.packageId || 'basic', packageName: 'الباقة الأساسية', price: Number(service.totalAmount), deliveryDays: service.totalDays, aiScore: service.aiScore || 0 }; }) } }, include: { items: true } });
      return created;
    });
    return { id: order.id, orderId: order.id, orderNumber: order.orderNumber, status: 'pending_payment', items: order.items.map(item => this.formatOrderItem(item)), subtotal: order.subtotal, discount: order.discount, total: order.total, couponCode: order.couponCode, createdAt: order.createdAt.toISOString() };
  }

  async getOrder(userId: string, id: string) {
    const order = await prisma.order.findFirst({ where: { id, userId }, include: { items: true } });
    if (!order) throw new AppError('الطلب غير موجود', 404);
    return { id: order.id, orderId: order.id, orderNumber: order.orderNumber, status: order.status.toLowerCase(), items: order.items.map(item => this.formatOrderItem(item)), subtotal: order.subtotal, discount: order.discount, total: order.total, couponCode: order.couponCode, createdAt: order.createdAt.toISOString() };
  }

  async getPaymentMethods(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);
    const balance = Number(user.walletBalance);
    console.debug(`[Checkout] getPaymentMethods userId=${userId} walletBalance=${balance}`);
    return [
      { id: 'card', name: 'بطاقة بنكية', available: true },
      { id: 'moyasar', name: 'ميسر', available: true },
      { id: 'wallet', name: 'المحفظة', available: true, balance },
      { id: 'stc_pay', name: 'STC Pay', available: false, badge: 'قريباً' },
      { id: 'apple_pay', name: 'Apple Pay', available: false, badge: 'قريباً' }
    ];
  }

  private async getPaymentOtp(userId: string, orderId: string) {
    const records = await prisma.otpVerification.findMany({ where: { userId, type: OtpType.EMAIL }, orderBy: { createdAt: 'desc' }, take: 20 });
    return records.find(record => (record.context as any)?.purpose === 'checkout_payment' && (record.context as any)?.orderId === orderId);
  }

  async initPayment(userId: string, orderId: string, paymentMethod: string) {
    if (!['card', 'moyasar', 'wallet'].includes(paymentMethod)) throw new AppError('طريقة الدفع غير متاحة', 400);
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { user: { select: { email: true, phoneNumber: true, walletBalance: true } } } });
    if (!order) throw new AppError('الطلب غير موجود', 404);
    if (order.status !== OrderStatus.PENDING_PAYMENT) throw new AppError('الطلب لا ينتظر الدفع', 400);
    if (paymentMethod === 'wallet' && Number(order.user.walletBalance) < order.total) {
      if (isTestCheckoutBypassEnabled()) {
        console.warn(`[TEST CHECKOUT BYPASS] initPayment — wallet balance insufficient but proceeding. userId=${userId} orderId=${orderId} balance=${Number(order.user.walletBalance)} total=${order.total}`);
      } else {
        throw new AppError('رصيد المحفظة غير كافٍ', 400);
      }
    }

    const paymentReference = `PAY-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    await prisma.otpVerification.deleteMany({ where: { userId, type: OtpType.EMAIL } });
    await prisma.otpVerification.create({ data: { userId, code, type: OtpType.EMAIL, expiresAt, context: this.paymentOtpContext(orderId, paymentReference, paymentMethod) } });
    if (process.env.NODE_ENV === 'development') console.info(`[DEV CHECKOUT OTP] ${order.user.email}: ${code}`);
    notificationService.sendEmailOtp(order.user.email, code).catch(() => undefined);
    return { paymentReference, otpSentTo: this.maskEmail(order.user.email), expiresAt: expiresAt.toISOString() };
  }

  async resendPaymentOtp(userId: string, orderId: string) {
    const previous = await this.getPaymentOtp(userId, orderId);
    if (!previous || previous.expiresAt < new Date()) throw new AppError('لا توجد عملية دفع فعالة، أعد تهيئة الدفع', 400);
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { user: { select: { email: true, phoneNumber: true } } } });
    if (!order || order.status !== OrderStatus.PENDING_PAYMENT) throw new AppError('الطلب لا ينتظر الدفع', 400);
    const context = previous.context as any;
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    await prisma.otpVerification.update({ where: { id: previous.id }, data: { code, expiresAt, attempts: 0 } });
    if (process.env.NODE_ENV === 'development') console.info(`[DEV CHECKOUT OTP] ${order.user.email}: ${code}`);
    notificationService.sendEmailOtp(order.user.email, code).catch(() => undefined);
    return { paymentReference: context.paymentReference, otpSentTo: this.maskEmail(order.user.email), expiresAt: expiresAt.toISOString() };
  }

  async confirmPayment(userId: string, orderId: string, otpCode: string) {
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { items: true, user: { select: { walletBalance: true } } } });
    if (!order) throw new AppError('الطلب غير موجود', 404);
    if (order.status !== OrderStatus.PENDING_PAYMENT) throw new AppError('الطلب مدفوع مسبقاً أو غير قابل للدفع', 400);
    const otp = await this.getPaymentOtp(userId, orderId);
    if (!otp || otp.expiresAt < new Date() || otp.code !== otpCode) {
      if (otp) await prisma.otpVerification.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new AppError('رمز التحقق غير صحيح', 400);
    }
    const context = otp.context as any;
    // Fetch ServiceStage templates for all ordered services (read-only, safe outside transaction)
    const serviceIds = order.items.map(item => item.serviceId).filter((id): id is string => Boolean(id));
    const allServiceStages = serviceIds.length > 0
      ? await prisma.serviceStage.findMany({ where: { serviceId: { in: serviceIds } }, orderBy: { stepOrder: 'asc' } })
      : [];
    const projectIds = await prisma.$transaction(async tx => {
      if (context.paymentMethod === 'wallet') {
        const walletBalance = Number(order.user.walletBalance);
        const bypass = isTestCheckoutBypassEnabled() && walletBalance < order.total;
        if (bypass) {
          console.warn(`[TEST CHECKOUT BYPASS] confirmPayment — purchase completed without enough wallet balance. userId=${userId} orderId=${order.id} balance=${walletBalance} total=${order.total}`);
          // Skip wallet deduction in bypass mode; record a TEST_WALLET_BYPASS transaction for audit.
          await tx.walletTransaction.create({ data: { userId, type: 'ORDER_PAYMENT', amount: -order.total, currency: 'SAR', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: context.paymentReference, description: `[TEST BYPASS] دفع الطلب ${order.orderNumber} (تجاوز رصيد المحفظة لأغراض الاختبار)`, metadata: { orderId: order.id, testBypass: true } } });
        } else {
          const debited = await tx.user.updateMany({ where: { id: userId, walletBalance: { gte: order.total } }, data: { walletBalance: { decrement: order.total } } });
          if (debited.count !== 1) throw new AppError('رصيد المحفظة غير كافٍ', 400);
          await tx.walletTransaction.create({ data: { userId, type: 'ORDER_PAYMENT', amount: -order.total, currency: 'SAR', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: context.paymentReference, description: `دفع الطلب ${order.orderNumber}`, metadata: { orderId: order.id } } });
        }
      }
      if (order.couponId) {
        const coupon = await tx.coupon.findUnique({ where: { id: order.couponId } });
        const now = new Date();
        if (!coupon || !coupon.active || coupon.startAt > now || (coupon.expiresAt && coupon.expiresAt < now)) throw new AppError('الكوبون لم يعد صالحا', 400);
        if (coupon.maxUses !== null) {
          const updated = await tx.coupon.updateMany({ where: { id: coupon.id, usedCount: { lt: coupon.maxUses } }, data: { usedCount: { increment: 1 } } });
          if (updated.count !== 1) throw new AppError('انتهت استعمالات الكوبون', 400);
        }
        const userUses = await tx.couponRedemption.count({ where: { couponId: coupon.id, userId } });
        if (userUses >= coupon.maxUsesPerUser) throw new AppError('لقد استعملت هذا الكوبون من قبل', 400);
        await tx.couponRedemption.create({ data: { couponId: coupon.id, userId, orderId: order.id, amount: order.discount } });
      }
      const createdProjectIds: string[] = [];
      for (const item of order.items) {
        const project = await tx.project.create({ data: { title: item.title, description: `طلب خدمة: ${item.title}`, specialty: 'Marketplace', subSpecialties: [], requirements: [], attachments: [], deliveryDays: item.deliveryDays, budgetType: 'fixed', budgetFixed: item.price, status: ProjectStatus.IN_PROGRESS, clientId: userId, providerId: item.providerId, serviceCatalogId: item.serviceId } });

        const stages = allServiceStages.filter(s => s.serviceId === item.serviceId);
        const phasesCount = stages.length || 1;

        const contract = await tx.contract.create({ data: { projectId: project.id, clientId: userId, providerId: item.providerId, price: item.price, durationDays: item.deliveryDays, phasesCount, status: ContractStatus.ACTIVE, signedAt: new Date() } });

        await tx.escrow.create({ data: { projectId: project.id, amount: item.price, status: EscrowStatus.HELD, paymentMethod: context.paymentMethod?.toUpperCase() || null, paymentReference: context.paymentReference || null, fundedAt: new Date() } });

        if (stages.length > 0) {
          await tx.projectStage.createMany({ data: stages.map((stage, index) => ({
            contractId: contract.id, stepOrder: stage.stepOrder, title: stage.title, description: stage.description,
            days: stage.deliveryDays, percentage: stage.percentage, amount: Number(stage.computedAmount),
            status: index === 0 ? ProjectStageStatus.IN_PROGRESS : ProjectStageStatus.PENDING,
            startedAt: index === 0 ? new Date() : null
          })) });
        } else {
          await tx.projectStage.create({ data: { contractId: contract.id, stepOrder: 1, title: 'المرحلة الأولى', description: 'تسليم المشروع النهائي', days: item.deliveryDays, percentage: 100, amount: item.price, status: ProjectStageStatus.IN_PROGRESS, startedAt: new Date() } });
        }

        createdProjectIds.push(project.id);
      }
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAID } });
      await tx.otpVerification.delete({ where: { id: otp.id } });
      return createdProjectIds;
    });
    return { orderId: order.id, orderNumber: order.orderNumber, status: 'paid', total: order.total, projectIds };
  }

  private formatOrderItem(item: any) {
    return { id: item.id, modelId: item.modelId, title: item.title, provider: { id: item.providerId, name: item.providerName, initials: item.initials, isVerified: item.isVerified }, packageName: item.packageName, price: item.price, deliveryDays: item.deliveryDays, aiScore: item.aiScore };
  }
}

export const cartCheckoutService = new CartCheckoutService();
