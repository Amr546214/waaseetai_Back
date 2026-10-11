import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// The provider's own public-profile preview shows the stored contact data (the same source as the profile data page); visitors and clients never receive it.
process.env.JWT_SECRET = 'test-secret';
process.env.OPENAI_API_KEY = 'test-key';

const profileRow = (user: any = {}) => ({
  id: 'pp-1', userId: 'user-1', firstName: 'سارة', lastName: 'أحمد', avatarUrl: null, headline: 'مصممة', mainSpecialty: 'design-creative', bio: 'x'.repeat(60), country: 'مصر', city: 'القاهرة',
  skills: [{ name: 'Figma' }], portfolioItems: [], providerSpecialties: [], isVerified: false, completionPercentage: 90, subSpecialties: [],
  user: { firstName: 'سارة', lastName: 'أحمد', email: 'sara@example.com', avatarUrl: null, phoneCountryCode: '+20', phoneNumber: '1025073026', createdAt: new Date('2026-01-01'), currentLevel: 'x', ratingAverage: 0, profileCompletionPercent: 0, accountType: 'PROVIDER_INDIVIDUAL', ...user },
});

async function load(t: TestContext, over: { user?: any } = {}) {
  // every other model answers "nothing" (empty list / 0 / null)
  const empty = new Proxy({}, { get: (_m, method: string) => async () => (method === 'count' ? 0 : method === 'findMany' ? [] : null) });
  const prisma: any = new Proxy({}, { get: (target: any, model: string) => target[model] ?? empty });
  prisma.providerProfile = { findUnique: async () => profileRow(over.user) };
  t.mock.module('../config/db', { namedExports: { prisma } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return providerProfileService;
}

test('owner view: the preview shows the stored email and the phone merged with its code (+20 1025073026), from the same data as the profile data page', async (t) => {
  const svc = await load(t);
  const view = await svc.getPublicProfile('user-1', { isOwner: true });
  assert.equal(view.contactVisibility, 'OWNER_ONLY');
  assert.equal(view.contact.email, 'sara@example.com');
  assert.equal(view.contact.phone.display, '+20 1025073026');
  assert.equal(view.contact.phone.countryCode, '+20');
  assert.equal(view.contact.phone.nationalNumber, '1025073026');
  assert.equal('pendingChange' in view.contact, false); // the e-mail and the phone are immutable: there is never a pending change to report
});

test('owner view: an Egyptian number that was stored next to +966 is shown as +20 (never as a Saudi number)', async (t) => {
  const svc = await load(t, { user: { phoneCountryCode: '+966', phoneNumber: '201025073026' } });
  const view = await svc.getPublicProfile('user-1', { isOwner: true });
  assert.equal(view.contact.phone.display, '+20 1025073026');
  assert.equal(view.contact.phone.consistent, false);
});

test('visitor / client view: no email and no phone anywhere in the answer, and the hiding is stated (HIDDEN_FROM_VISITORS), different from the owner view', async (t) => {
  const svc = await load(t);
  const view = await svc.getPublicProfile('user-1');
  assert.equal(view.contact, null);
  assert.equal(view.contactVisibility, 'HIDDEN_FROM_VISITORS');
  const json = JSON.stringify(view);
  for (const secret of ['sara@example.com', '1025073026', '+20', 'phoneNumber', 'phoneCountryCode']) assert.equal(json.includes(secret), false, secret);
});
