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
    profileModificationRequest: { count: async () => { if (opts.countThrows) throw new Error('db down'); return opts.pendingDocs ?? 0; } },
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
