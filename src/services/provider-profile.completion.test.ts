import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// GET /provider/profile returns the true completion and what is missing; a pending ID review is "قيد المراجعة".
// Kept in its own file with NO static import of the service (it captures the real prisma at load otherwise).
process.env.JWT_SECRET = 'test-secret';
process.env.OPENAI_API_KEY = 'test-key';

const user = (over: any = {}) => ({ firstName: 'سارة', lastName: 'أحمد', email: 'p@example.com', avatarUrl: null, phoneNumber: '0500000000', alternativePhone: null,
  accountHolderName: null, ibanNumber: null, bankName: null, idDocumentUrl: null, commercialRegistration: null, vatCertificateUrl: null, ...over });

const fullProfile = (over: any = {}) => ({
  id: 'pp-1', userId: 'user-1', firstName: 'سارة', lastName: 'أحمد', avatarUrl: 'https://x/a.png', headline: 'مصممة', mainSpecialty: 'design',
  bio: 'x'.repeat(60), country: 'SA', city: 'Riyadh', websiteUrl: 'https://x.example', paypalPayoutEmail: 'pay@example.com',
  skills: [{ name: 'Figma' }], portfolioItems: [], educations: [], certificates: [], completionPercentage: 0, ...over,
});

async function load(t: TestContext, opts: { profile: any; user: any; pendingDocs?: number; countThrows?: boolean }) {
  const updateSpy = t.mock.fn((args: any) => ({ id: 'pp-1', ...args.data }));
  t.mock.module('../config/db', { namedExports: { prisma: {
    providerProfile: { findUnique: async () => ({ ...opts.profile, user: { ...opts.user } }), update: async (a: any) => updateSpy(a) },
    profileModificationRequest: {
      count: async () => { if (opts.countThrows) throw new Error('db down'); return opts.pendingDocs ?? 0; },
      findFirst: async () => { if (opts.countThrows) throw new Error('db down'); return opts.pendingDocs ? { id: 'req-1', status: 'PENDING_HUMAN_REVIEW', createdAt: new Date('2026-10-10T10:00:00Z'), rejectionReason: null } : null; },
      findMany: async () => (opts.pendingDocs ? [{ id: 'req-1', category: 'DOCUMENTS', status: 'PENDING_HUMAN_REVIEW', createdAt: new Date('2026-10-10T10:00:00Z'), reviewedByAdmin: null }] : []),
    },
  } } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: providerProfileService, updateSpy };
}

test('GET: a provider with PayPal and an approved ID is 100% with nothing missing; the stored value is synced', async (t) => {
  const { service, updateSpy } = await load(t, { profile: fullProfile({ completionPercentage: 75 }), user: user({ idDocumentUrl: 'https://x/id.pdf' }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 100);
  assert.deepEqual(p.missingItems, []);
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.completionPercentage, 100);
});

test('GET: no PayPal -> a "payout" item is listed as missing and the percentage drops by 10', async (t) => {
  const { service } = await load(t, { profile: fullProfile({ paypalPayoutEmail: null }), user: user({ idDocumentUrl: 'https://x/id.pdf' }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 90);
  assert.deepEqual(p.missingItems.map((i: any) => [i.key, i.status, i.tab]), [['payout', 'missing', 'payout']]);
});

test('GET: a pending ID-document review shows "pending_review" (قيد المراجعة), not missing', async (t) => {
  const { service } = await load(t, { profile: fullProfile(), user: user(), pendingDocs: 1 });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 90);
  assert.deepEqual(p.missingItems.map((i: any) => [i.key, i.status, i.tab]), [['idDocument', 'pending_review', 'docs']]);
  assert.match(p.missingItems[0].hint, /قيد المراجعة/);
});

test('GET: an ID gap without any pending request is plainly missing', async (t) => {
  const { service } = await load(t, { profile: fullProfile(), user: user(), pendingDocs: 0 });
  assert.equal((await service.getProfile('user-1')).missingItems[0].status, 'missing');
});

test('GET: User.ibanNumber no longer counts (an IBAN-only provider is told to add PayPal)', async (t) => {
  const { service } = await load(t, { profile: fullProfile({ paypalPayoutEmail: null }), user: user({ ibanNumber: 'SA0380000000608010167519', idDocumentUrl: 'https://x/id.pdf' }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 90);
  assert.equal(p.missingItems.some((i: any) => i.key === 'payout'), true);
});

test('GET: a failing pending-review lookup never breaks the profile read (falls back to "missing")', async (t) => {
  const { service } = await load(t, { profile: fullProfile(), user: user(), countThrows: true });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 90);
  assert.equal(p.missingItems[0].status, 'missing');
});

test('GET: the stored percentage is not rewritten when it is already correct', async (t) => {
  const { service, updateSpy } = await load(t, { profile: fullProfile({ completionPercentage: 90 }), user: user() });
  await service.getProfile('user-1');
  assert.equal(updateSpy.mock.callCount(), 0);
});

// ── the identity sent in the SETUP (KYC review) follows the same lifecycle as a DOCUMENTS request: one status in every read ──
const items = (p: any) => p.missingItems.map((i: any) => [i.key, i.status]);

test('GET: an ID sent in the setup and waiting for the admin KYC review is PENDING_REVIEW everywhere: item "قيد المراجعة", not missing, category KYC', async (t) => {
  const { service } = await load(t, { profile: fullProfile({ kycStatus: 'PENDING', frontIdUrl: 'private:image:png:waseetai/providers/user-1/identity/f' }), user: user() });
  const p = await service.getProfile('user-1');
  assert.deepEqual(items(p), [['idDocument', 'pending_review']]);
  assert.match(p.missingItems[0].hint, /قيد المراجعة/);
  assert.equal(p.identityVerification.status, 'PENDING_REVIEW');
  assert.equal(p.identityVerification.category, 'KYC');
  assert.equal(p.reviewStatus.identity.status, 'PENDING_REVIEW');
  assert.equal(p.reviewStatus.identity.category, 'KYC');
  assert.equal(p.completionPercentage, 90); // counted only once approved
});

test('GET: the admin APPROVES the identity (KYC VERIFIED): APPROVED, off the checklist, and the percentage reaches 100 (list and number agree)', async (t) => {
  const { service } = await load(t, { profile: fullProfile({ kycStatus: 'VERIFIED' }), user: user() });
  const p = await service.getProfile('user-1');
  assert.deepEqual(p.missingItems, []);
  assert.equal(p.completionPercentage, 100);
  assert.equal(p.identityVerification.status, 'VERIFIED');
  assert.equal(p.reviewStatus.identity.status, 'APPROVED');
});

test('GET: the admin REJECTS the identity: REJECTED with the admin reason, the item says so and a re-upload is allowed (no "pending")', async (t) => {
  const { service } = await load(t, { profile: fullProfile({ kycStatus: 'REJECTED', notes: 'سبب الرفض: الصورة غير واضحة' }), user: user() });
  const p = await service.getProfile('user-1');
  assert.deepEqual(items(p), [['idDocument', 'rejected']]);
  assert.equal(p.identityVerification.status, 'REJECTED');
  assert.equal(p.identityVerification.rejectionReason, 'الصورة غير واضحة');
  assert.equal(p.reviewStatus.identity.status, 'REJECTED');
  assert.equal(p.reviewStatus.identity.rejectionReason, 'الصورة غير واضحة');
  assert.equal('notes' in p, false); // the raw internal note is never returned
});

test('GET: nothing sent: NOT_SUBMITTED and the item is plainly missing', async (t) => {
  const { service } = await load(t, { profile: fullProfile({ kycStatus: 'UNVERIFIED' }), user: user() });
  const p = await service.getProfile('user-1');
  assert.deepEqual(items(p), [['idDocument', 'missing']]);
  assert.equal(p.identityVerification.status, 'NOT_SUBMITTED');
  assert.equal(p.reviewStatus.identity.status, 'NOT_SUBMITTED');
});

test('GET: a DOCUMENTS request from the profile page reports requestId, category and submittedAt (the same four statuses)', async (t) => {
  const { service } = await load(t, { profile: fullProfile(), user: user(), pendingDocs: 1 });
  const p = await service.getProfile('user-1');
  assert.deepEqual([p.identityVerification.status, p.identityVerification.category, p.identityVerification.requestId], ['PENDING_REVIEW', 'DOCUMENTS', 'req-1']);
  assert.equal(p.identityVerification.submittedAt, '2026-10-10T10:00:00.000Z');
});
