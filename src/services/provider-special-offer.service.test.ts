import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createSpecialOfferSchema, updateSpecialOfferSchema } from '../dtos/special-offer.dto';

// Phase 6 — special offers. Same Prisma mocking approach as
// provider-coupon.service.test.ts (t.mock.module('../config/db', ...)) —
// no real DB involved.

const SERVICE_X = '11111111-1111-4111-8111-111111111111';
const SERVICE_Y = '22222222-2222-4222-8222-222222222222';
const SERVICE_Z = '33333333-3333-4333-8333-333333333333';

async function loadService(t: TestContext, overrides: { accountType: string; existingOffer?: any; serviceOwner?: string; companyTeamMember?: any }) {
  const providerId = 'provider-1';
  const createSpy = t.mock.fn(async ({ data }: any) => ({ ...data, id: 'offer-1', usedCount: 0 }));
  const updateSpy = t.mock.fn(async ({ data }: any) => ({ ...overrides.existingOffer, ...data }));

  const prismaMock: any = {
    serviceCatalog: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id, providerId: overrides.serviceOwner ?? providerId })) },
    specialOffer: {
      findFirst: async () => overrides.existingOffer ?? null,
      create: createSpy,
      update: updateSpy,
      updateMany: async () => ({ count: overrides.existingOffer ? 1 : 0 })
    },
    user: { findUnique: async () => ({ accountType: overrides.accountType }) },
    companyTeamMember: { findFirst: async () => (overrides.companyTeamMember === undefined ? { id: 'member-1' } : overrides.companyTeamMember) },
    $transaction: async (fn: any) => fn(prismaMock)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./provider-special-offer.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { providerSpecialOfferService } = await import(moduleUrl);
  return { providerSpecialOfferService, createSpy, updateSpy, providerId };
}

const bundle = (discountValue: number) => ({ type: 'BUNDLE', name: 'باقة العرض', primaryServiceId: SERVICE_X, beneficiaryServiceId: SERVICE_Y, validityDays: 14, discountValue, badgeText: 'عرض باقة' });
const direct = (discountValue: number) => ({ type: 'DIRECT_DISCOUNT', name: 'خصم مباشر', targetServiceId: SERVICE_Z, discountValue, badgeText: 'خصم' });

// --- DTO: BUNDLE vs DIRECT_DISCOUNT shape --------------------------------

test('dto: valid BUNDLE and DIRECT_DISCOUNT payloads parse', () => {
  assert.equal(createSpecialOfferSchema.safeParse(bundle(20)).success, true);
  assert.equal(createSpecialOfferSchema.safeParse(direct(20)).success, true);
});

test('dto: BUNDLE without beneficiaryServiceId / validityDays is rejected', () => {
  assert.equal(createSpecialOfferSchema.safeParse({ ...bundle(20), beneficiaryServiceId: undefined }).success, false);
  assert.equal(createSpecialOfferSchema.safeParse({ ...bundle(20), validityDays: undefined }).success, false);
});

test('dto: BUNDLE with the same primary and beneficiary service is rejected', () => {
  assert.equal(createSpecialOfferSchema.safeParse({ ...bundle(20), beneficiaryServiceId: SERVICE_X }).success, false);
});

test('dto: DIRECT_DISCOUNT without targetServiceId, or with bundle fields, is rejected', () => {
  assert.equal(createSpecialOfferSchema.safeParse({ ...direct(20), targetServiceId: undefined }).success, false);
  assert.equal(createSpecialOfferSchema.safeParse({ ...direct(20), primaryServiceId: SERVICE_X }).success, false);
});

test('dto: discountValue must be within (0, 100] and expiresAt after startAt', () => {
  assert.equal(createSpecialOfferSchema.safeParse(direct(0)).success, false);
  assert.equal(createSpecialOfferSchema.safeParse(direct(101)).success, false);
  assert.equal(createSpecialOfferSchema.safeParse({ ...direct(10), startAt: '2026-10-10', expiresAt: '2026-10-01' }).success, false);
  assert.equal(updateSpecialOfferSchema.safeParse({ discountValue: 150 }).success, false);
});

// --- create(): approval threshold ----------------------------------------

test('create: PROVIDER_INDIVIDUAL with 80% discount is always auto-approved and active', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL' });
  const result = await providerSpecialOfferService.create(providerId, bundle(80));
  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('create: PROVIDER_COMPANY with discount > 30 is PENDING and forced inactive', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });
  const result = await providerSpecialOfferService.create(providerId, direct(31));
  assert.equal(result.approvalStatus, 'PENDING');
  assert.equal(result.active, false);
});

test('create: PROVIDER_COMPANY with discount exactly 30 is auto-approved (boundary is > 30)', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY' });
  const result = await providerSpecialOfferService.create(providerId, direct(30));
  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('create: BUNDLE persists only bundle fields; DIRECT_DISCOUNT only the target', async (t) => {
  const { providerSpecialOfferService, providerId, createSpy } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL' });
  const b = await providerSpecialOfferService.create(providerId, bundle(10));
  assert.equal(b.primaryServiceId, SERVICE_X);
  assert.equal(b.beneficiaryServiceId, SERVICE_Y);
  assert.equal(b.targetServiceId, null);
  const d = await providerSpecialOfferService.create(providerId, direct(10));
  assert.equal(d.targetServiceId, SERVICE_Z);
  assert.equal(d.primaryServiceId, null);
  assert.equal(d.validityDays, null);
  assert.equal(createSpy.mock.callCount(), 2);
});

test('create: rejects a service that belongs to another provider', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL', serviceOwner: 'someone-else' });
  await assert.rejects(() => providerSpecialOfferService.create(providerId, direct(10)), /لا تخص هذا المقدم/);
});

test('create: rejects a team member outside this company roster (tenant isolation)', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', companyTeamMember: null });
  await assert.rejects(() => providerSpecialOfferService.create(providerId, { ...direct(10), assignedToTeamMemberId: 'foreign-member' }), /عضو الفريق غير موجود/);
});

// --- update() -------------------------------------------------------------

const existingDirect = (extra: any = {}) => ({ id: 'offer-1', providerId: 'provider-1', type: 'DIRECT_DISCOUNT', targetServiceId: SERVICE_Z, primaryServiceId: null, beneficiaryServiceId: null, validityDays: null, discountValue: 20, approvalStatus: 'APPROVED', active: true, expiresAt: null, startAt: new Date('2026-01-01'), ...extra });

test('update: PROVIDER_COMPANY raising discount above 30 flips to PENDING and overrides active=true', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: existingDirect() });
  const result = await providerSpecialOfferService.update(providerId, 'offer-1', { discountValue: 45, active: true });
  assert.equal(result.approvalStatus, 'PENDING');
  assert.equal(result.active, false);
});

test('update: PROVIDER_COMPANY cannot activate an already-PENDING offer by editing an unrelated field', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: existingDirect({ discountValue: 45, approvalStatus: 'PENDING', active: false }) });
  const result = await providerSpecialOfferService.update(providerId, 'offer-1', { active: true, badgeText: 'جديد' });
  assert.equal(result.active, false);
});

test('update: PROVIDER_INDIVIDUAL is never forced inactive', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL', existingOffer: existingDirect() });
  const result = await providerSpecialOfferService.update(providerId, 'offer-1', { discountValue: 90, active: true });
  assert.equal(result.active, true);
});

test('update: switching DIRECT_DISCOUNT -> BUNDLE clears targetServiceId and requires bundle fields', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL', existingOffer: existingDirect() });
  await assert.rejects(() => providerSpecialOfferService.update(providerId, 'offer-1', { type: 'BUNDLE' }), /النموذج الأساسي/);
  const result = await providerSpecialOfferService.update(providerId, 'offer-1', { type: 'BUNDLE', primaryServiceId: SERVICE_X, beneficiaryServiceId: SERVICE_Y, validityDays: 7 });
  assert.equal(result.type, 'BUNDLE');
  assert.equal(result.targetServiceId, null);
});

test('update: throws when the offer does not exist for this provider', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: null });
  await assert.rejects(() => providerSpecialOfferService.update(providerId, 'missing', { badgeText: 'x' }), /غير موجود/);
});

// --- remove() / decideApproval() -----------------------------------------

test('remove: soft-deactivates', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL', existingOffer: existingDirect() });
  assert.deepEqual(await providerSpecialOfferService.remove(providerId, 'offer-1'), { id: 'offer-1', active: false });
});

test('decideApproval: APPROVED activates a non-expired PENDING offer', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: existingDirect({ approvalStatus: 'PENDING', active: false }) });
  const result = await providerSpecialOfferService.decideApproval(providerId, 'offer-1', { decision: 'APPROVED' });
  assert.equal(result.approvalStatus, 'APPROVED');
  assert.equal(result.active, true);
});

test('decideApproval: APPROVED does not reactivate an expired offer', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: existingDirect({ approvalStatus: 'PENDING', active: false, expiresAt: new Date('2020-01-01') }) });
  const result = await providerSpecialOfferService.decideApproval(providerId, 'offer-1', { decision: 'APPROVED' });
  assert.equal(result.active, false);
});

test('decideApproval: REJECTED stores reason and keeps inactive', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: existingDirect({ approvalStatus: 'PENDING', active: false }) });
  const result = await providerSpecialOfferService.decideApproval(providerId, 'offer-1', { decision: 'REJECTED', rejectionReason: 'خصم مرتفع' });
  assert.equal(result.approvalStatus, 'REJECTED');
  assert.equal(result.active, false);
  assert.equal(result.rejectionReason, 'خصم مرتفع');
});

test('decideApproval: rejects a decision on a non-PENDING offer', async (t) => {
  const { providerSpecialOfferService, providerId } = await loadService(t, { accountType: 'PROVIDER_COMPANY', existingOffer: existingDirect() });
  await assert.rejects(() => providerSpecialOfferService.decideApproval(providerId, 'offer-1', { decision: 'REJECTED', rejectionReason: 'x' }), /بانتظار الموافقة/);
});
