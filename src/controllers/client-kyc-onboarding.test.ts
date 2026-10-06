import { test, mock, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// AUD-FND-000044: submitting the client setup wizard with complete identity documents creates/refreshes a PENDING ClientOnboarding row
// (what the admin review list reads); admin decisions flow back to kycStatus; the public client `isVerified` comes from kycStatus.

type Onb = { userId: string; status: string; documentUrl: string; documentName: string; documentType: string; rejectionReason: string | null; reviewedAt: Date | null } | null;
type State = { onboarding: Onb; kyc: string; creates: number; updates: any[]; kycUpdates: any[] };

// One set of module mocks for the whole file (the services are imported once); each test resets the shared state through reset().
const S: State = { onboarding: null, kyc: 'UNVERIFIED', creates: 0, updates: [], kycUpdates: [] };
let publicKyc = 'PENDING';
let adminKyc: string[] = [];
const prisma: any = {
  clientOnboarding: {
    findUnique: async ({ where }: any = {}) => (S.onboarding ? { id: 'o1', ...S.onboarding } : null),
    create: async ({ data }: any) => { S.creates++; S.onboarding = { rejectionReason: null, reviewedAt: null, ...data }; return { ...S.onboarding }; },
    update: async ({ data }: any) => { S.updates.push(data); S.onboarding = { ...S.onboarding!, ...data }; return { id: 'o1', ...S.onboarding }; },
    findMany: async ({ where }: any) => (S.onboarding && (!where?.status || where.status === S.onboarding.status) ? [{ id: 'o1', createdAt: new Date(), ...S.onboarding, user: {} }] : []),
    count: async ({ where }: any) => (S.onboarding && (!where?.status || where.status === S.onboarding.status) ? 1 : 0),
  },
  clientProfile: {
    upsert: async ({ create }: any) => ({ id: 'cp1', userId: 'u1', ...create, kycStatus: S.kyc }),
    update: async ({ data }: any) => ({ id: 'cp1', ...data }),
    updateMany: async (a: any) => {
      S.kycUpdates.push(a);
      adminKyc.push(a.data.kycStatus);
      const allowed = a.where.kycStatus?.in as string[] | undefined;
      if (!allowed || allowed.includes(S.kyc)) { S.kyc = a.data.kycStatus; return { count: 1 }; }
      return { count: 0 };
    },
    findUnique: async () => ({ kycStatus: S.kyc, firstName: null, lastName: null, avatarUrl: null, bio: null, city: null, country: null, isNafathVerified: true, ...(publicKyc ? { kycStatus: publicKyc } : {}) }),
  },
  user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE', firstName: 'a', lastName: 'b', avatarUrl: null, createdAt: new Date() }) },
  project: { count: async () => 0 }, contract: { count: async () => 0 },
  review: { count: async () => 0, aggregate: async () => ({ _avg: { rating: null } }), findMany: async () => [] },
  $transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops({})),
};
let loaded: Promise<{ ClientProfileController: any; OnboardingService: any; clientProfileService: any }> | null = null;
function load() {
  if (loaded) return loaded;
  mock.module('../config/db', { namedExports: { prisma } });
  mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
  mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null } });
  mock.module('../utils/completion-calculators', { namedExports: { computeClientCompletion: () => 80, computeClientMissingItems: () => [] } });
  loaded = (async () => ({
    ClientProfileController: (await import('./client-profile.controller.ts')).ClientProfileController,
    OnboardingService: (await import('../services/onboarding.service.ts')).OnboardingService,
    clientProfileService: (await import('../services/client-profile.service.ts')).clientProfileService,
  }))();
  return loaded;
}
function reset(init: { onboarding?: Onb; kyc?: string } = {}) {
  S.onboarding = init.onboarding ?? null; S.kyc = init.kyc ?? 'UNVERIFIED'; S.creates = 0; S.updates = []; S.kycUpdates = []; adminKyc = []; publicKyc = '';
}

async function submit(_t: TestContext, init: { onboarding?: Onb; kyc?: string }, identity: any = { frontId: 'https://cdn/f.jpg', backId: 'https://cdn/b.jpg' }, idNumber = '1234567890') {
  reset(init);
  const { ClientProfileController } = await load();
  const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  await new ClientProfileController().saveSetupData({ user: { userId: 'u1' }, body: { details: { idNumber }, identity, documents: {}, agreements: {}, bank: {} } } as any, res, (e: any) => { throw e; });
  assert.equal(res.statusCode, 200);
  return { ...S, onboarding: S.onboarding, kyc: S.kyc, creates: S.creates, updates: [...S.updates] };
}

test('#44 complete identity documents create a PENDING ClientOnboarding row and move kycStatus to PENDING', async (t) => {
  const S = await submit(t, {});
  assert.equal(S.creates, 1);
  assert.equal(S.onboarding?.status, 'PENDING');
  assert.equal(S.onboarding?.documentUrl, 'https://cdn/f.jpg');
  assert.equal(S.kyc, 'PENDING');
});

test('#44 incomplete documents (no back side) create nothing and leave kycStatus alone', async (t) => {
  const a = await submit(t, {}, { frontId: 'https://cdn/f.jpg' });
  assert.equal(a.creates, 0);
  assert.equal(a.kyc, 'UNVERIFIED');
});

test('#44 no id number → nothing created, kycStatus untouched', async (t) => {
  const b = await submit(t, {}, { frontId: 'x', backId: 'y' }, '');
  assert.equal(b.creates, 0);
  assert.equal(b.kyc, 'UNVERIFIED');
});

test('#44 re-submitting while PENDING does not duplicate the record (documents are refreshed)', async (t) => {
  const row = { userId: 'u1', status: 'PENDING', documentUrl: 'old', documentName: 'n', documentType: 'NATIONAL_ID', rejectionReason: null, reviewedAt: null };
  const S = await submit(t, { onboarding: row, kyc: 'PENDING' });
  assert.equal(S.creates, 0);
  assert.equal(S.onboarding?.status, 'PENDING');
  assert.equal(S.onboarding?.documentUrl, 'https://cdn/f.jpg');
});

test('#44 an APPROVED client is never pushed back: the record and a VERIFIED kycStatus stay as they are', async (t) => {
  const row = { userId: 'u1', status: 'APPROVED', documentUrl: 'old', documentName: 'n', documentType: 'NATIONAL_ID', rejectionReason: null, reviewedAt: new Date() };
  const S = await submit(t, { onboarding: row, kyc: 'VERIFIED' });
  assert.equal(S.creates, 0);
  assert.equal(S.updates.length, 0);
  assert.equal(S.onboarding?.status, 'APPROVED');
  assert.equal(S.kyc, 'VERIFIED');
});

test('#44 a REJECTED client re-submitting goes back to PENDING (reason cleared, kycStatus PENDING)', async (t) => {
  const row = { userId: 'u1', status: 'REJECTED', documentUrl: 'old', documentName: 'n', documentType: 'NATIONAL_ID', rejectionReason: 'صورة غير واضحة', reviewedAt: new Date() };
  const S = await submit(t, { onboarding: row, kyc: 'REJECTED' });
  assert.equal(S.onboarding?.status, 'PENDING');
  assert.equal(S.onboarding?.rejectionReason, null);
  assert.equal(S.onboarding?.reviewedAt, null);
  assert.equal(S.kyc, 'PENDING');
});

test('#44 the new record appears in the admin list (same table/status the list reads) and shows the profile kycStatus', async (t) => {
  await submit(t, {});
  const { OnboardingService } = await load();
  const list = await new OnboardingService().listOnboarding('PENDING' as any);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].clientProfileKycStatus, 'PENDING');
  assert.equal(list.pagination.total, 1);
  assert.equal((await new OnboardingService().listOnboarding('APPROVED' as any)).items.length, 0);
});

test('#44 approve → APPROVED + kycStatus VERIFIED; reject → REJECTED + kycStatus REJECTED (unchanged admin decision)', async (t) => {
  await submit(t, {});
  const { OnboardingService } = await load();
  const svc = new OnboardingService();
  adminKyc = [];
  const approved = await svc.approveOnboarding('o1');
  assert.equal(approved.status, 'APPROVED');
  S.onboarding = { ...S.onboarding!, status: 'PENDING' };
  const rejected = await svc.rejectOnboarding('o1', { rejectionReason: 'سبب' } as any);
  assert.equal(rejected.status, 'REJECTED');
  assert.deepEqual(adminKyc, ['VERIFIED', 'REJECTED']);
});

test('isVerified (public client profile): a legacy isNafathVerified=true with kycStatus != VERIFIED is false; VERIFIED is true', async (t) => {
  const { clientProfileService } = await load();
  for (const k of ['UNVERIFIED', 'PENDING', 'REJECTED']) { reset(); publicKyc = k; assert.equal((await clientProfileService.getPublicProfile('u1')).isVerified, false, k); }
  reset(); publicKyc = 'VERIFIED';
  assert.equal((await clientProfileService.getPublicProfile('u1')).isVerified, true);
});
