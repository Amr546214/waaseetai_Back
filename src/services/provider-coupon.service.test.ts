import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 5 — company approval-threshold workflow: a PROVIDER_COMPANY coupon
// must land PENDING + forced-inactive when discountValue > 30% (percentage
// type) or maxUses is null/undefined (unlimited), and stay auto-APPROVED
// otherwise — exactly like a PROVIDER_INDIVIDUAL coupon always is. These
// tests mock Prisma the same way cart-checkout.service.test.ts does
// (t.mock.module('../config/db', ...)) — no real DB involved.

function makeServiceCatalogFindMany(providerId: string) {
  return async ({ where }: any) => {
    const ids: string[] = where.id.in;
    return ids.map(id => ({ id, providerId }));
  };
}

async function loadService(t: TestContext, overrides: { accountType: string; couponCreate?: any; existingCoupon?: any; companyTeamMember?: any }) {
  const providerId = 'provider-1';
  const createSpy = t.mock.fn(async ({ data }: any) => ({ ...data, id: 'coupon-1', usedCount: 0, services: (data.services?.create ?? []).map((s: any) => ({ serviceId: s.serviceId })) }));

  const prismaMock: any = {
    serviceCatalog: { findMany: makeServiceCatalogFindMany(providerId) },
    coupon: {
      findUnique: async () => null,
      findFirst: async () => overrides.existingCoupon ?? null,
      create: overrides.couponCreate ?? createSpy,
      update: async ({ data }: any) => ({ ...overrides.existingCoupon, ...data, services: [] })
    },
    couponService: { deleteMany: async () => ({}), createMany: async () => ({}) },
    user: { findUnique: async () => ({ accountType: overrides.accountType }) },
    companyTeamMember: { findFirst: async () => overrides.companyTeamMember ?? { id: 'member-1' } },
    $transaction: async (fn: any) => fn(prismaMock)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./provider-coupon.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerCouponService } = await import(moduleUrl);
  return { providerCouponService, createSpy, providerId };
}

// --- create(): PROVIDER_INDIVIDUAL always auto-approved -------------------

test('create: PROVIDER_INDIVIDUAL with 50% discount is always auto-approved and active', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL' });

  const result = await providerCouponService.create(providerId, {
    code: 'BIG50', discountType: 'percentage', discountValue: 50, serviceIds: ['service-1'], maxUsesPerUser: 1
  });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('create: PROVIDER_INDIVIDUAL with no maxUses cap is still always auto-approved', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL' });

  const result = await providerCouponService.create(providerId, {
    code: 'NOCAP', discountType: 'fixed', discountValue: 10, serviceIds: ['service-1'], maxUsesPerUser: 1
  });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

// --- create(): PROVIDER_COMPANY threshold logic ----------------------------

test('create: PROVIDER_COMPANY with percentage discount > 30 is PENDING and forced inactive', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });

  const result = await providerCouponService.create(providerId, {
    code: 'BIG31', discountType: 'percentage', discountValue: 31, serviceIds: ['service-1'], maxUses: 100, maxUsesPerUser: 1
  });

  assert.equal(result.approvalStatus, 'PENDING');
  assert.equal(result.active, false);
});

test('create: PROVIDER_COMPANY with percentage discount exactly at 30 is auto-approved (boundary is > 30, not >= 30)', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });

  const result = await providerCouponService.create(providerId, {
    code: 'EXACT30', discountType: 'percentage', discountValue: 30, serviceIds: ['service-1'], maxUses: 100, maxUsesPerUser: 1
  });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('create: PROVIDER_COMPANY with no maxUses cap (unlimited) is PENDING and forced inactive, even at a low discount', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });

  const result = await providerCouponService.create(providerId, {
    code: 'UNLIMITED', discountType: 'percentage', discountValue: 5, serviceIds: ['service-1'], maxUsesPerUser: 1
    // maxUses intentionally omitted
  });

  assert.equal(result.approvalStatus, 'PENDING');
  assert.equal(result.active, false);
});

test('create: PROVIDER_COMPANY with a capped, low-percentage discount is auto-approved and active', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });

  const result = await providerCouponService.create(providerId, {
    code: 'SAFE10', discountType: 'percentage', discountValue: 10, serviceIds: ['service-1'], maxUses: 50, maxUsesPerUser: 1
  });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('create: PROVIDER_COMPANY with a capped "fixed" discount above 30 is NOT pending (>30 threshold only applies to percentage type)', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });

  const result = await providerCouponService.create(providerId, {
    code: 'FIXED99', discountType: 'fixed', discountValue: 99, serviceIds: ['service-1'], maxUses: 50, maxUsesPerUser: 1
  });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

// --- update(): re-evaluated only when discount/maxUses change -------------

test('update: PROVIDER_COMPANY raising discountValue above 30 flips an approved coupon to PENDING and forces inactive', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', discountType: 'percentage', discountValue: 20, maxUses: 100, approvalStatus: 'APPROVED', active: true };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.update(providerId, 'coupon-1', { discountValue: 45, active: true });

  assert.equal(result.approvalStatus, 'PENDING');
  assert.equal(result.active, false); // caller's `active: true` is overridden
});

test('update: PROVIDER_COMPANY editing an unrelated field on an already-PENDING coupon cannot sneak `active: true` past the approval gate', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', discountType: 'percentage', discountValue: 45, maxUses: null, approvalStatus: 'PENDING', active: false };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.update(providerId, 'coupon-1', { active: true, minimumAmount: 50 });

  assert.equal(result.active, false);
});

test('update: PROVIDER_COMPANY setting maxUses to null (removing the cap) flips an approved coupon to PENDING', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', discountType: 'percentage', discountValue: 10, maxUses: 100, approvalStatus: 'APPROVED', active: true };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.update(providerId, 'coupon-1', { maxUses: null });

  assert.equal(result.approvalStatus, 'PENDING');
  assert.equal(result.active, false);
});

test('update: PROVIDER_COMPANY lowering discountValue back under the threshold returns to APPROVED', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', discountType: 'percentage', discountValue: 45, maxUses: 100, approvalStatus: 'PENDING', active: false };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.update(providerId, 'coupon-1', { discountValue: 15 });

  assert.equal(result.approvalStatus, 'APPROVED');
});

test('update: PROVIDER_INDIVIDUAL is never forced inactive regardless of discount/maxUses edits', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', discountType: 'percentage', discountValue: 10, maxUses: 100, approvalStatus: 'APPROVED', active: true };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL', existingCoupon });

  const result = await providerCouponService.update(providerId, 'coupon-1', { discountValue: 90, maxUses: null, active: true });

  assert.equal(result.active, true);
});

// --- decideApproval(): approve/reject on PENDING only ----------------------

test('decideApproval: APPROVED sets approvalStatus=APPROVED and active=true when not expired', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', approvalStatus: 'PENDING', active: false, expiresAt: null };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.decideApproval(providerId, 'coupon-1', { decision: 'APPROVED' });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('decideApproval: APPROVED does not reactivate an already-expired coupon', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', approvalStatus: 'PENDING', active: false, expiresAt: new Date('2020-01-01') };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.decideApproval(providerId, 'coupon-1', { decision: 'APPROVED' });

  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, false);
});

test('decideApproval: REJECTED sets approvalStatus=REJECTED, active=false, and stores the rejection reason', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', approvalStatus: 'PENDING', active: false, expiresAt: null };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  const result = await providerCouponService.decideApproval(providerId, 'coupon-1', { decision: 'REJECTED', rejectionReason: 'نسبة خصم مرتفعة جدا' });

  assert.equal(result.approvalStatus, 'REJECTED');
  assert.equal(result.active, false);
  assert.equal(result.rejectionReason, 'نسبة خصم مرتفعة جدا');
});

test('decideApproval: rejects a decision on a coupon that is not PENDING', async (t) => {
  const existingCoupon = { id: 'coupon-1', providerId: 'provider-1', approvalStatus: 'APPROVED', active: true, expiresAt: null };
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon });

  await assert.rejects(() => providerCouponService.decideApproval(providerId, 'coupon-1', { decision: 'REJECTED' }), /بانتظار الموافقة/);
});

test('decideApproval: throws when the coupon does not exist for this provider', async (t) => {
  const { providerCouponService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingCoupon: null });

  await assert.rejects(() => providerCouponService.decideApproval(providerId, 'missing-coupon', { decision: 'APPROVED' }), /غير موجود/);
});
