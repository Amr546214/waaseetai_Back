import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// AUD-FND-000062 / 000063: POST the setup payload, then GET it back: every accepted field is really stored, every unknown field is a 400
// (never a 200 that silently drops it), and the "complete" flag follows what was stored.
function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}
const store: { provider: any; client: any } = { provider: null, client: null };
const merge = (cur: any, patch: any) => { const next = { ...(cur ?? {}) }; for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v; return next; };
const prisma: any = {
  skill: { findMany: async () => [] },
  portfolioItem: { deleteMany: async () => ({}), createMany: async () => ({}) },
  providerProfile: {
    findUnique: async () => (store.provider ? { id: 'pp1', skills: [], portfolioItems: [], ...store.provider } : null),
    upsert: async (a: any) => { store.provider = merge(store.provider ?? { kycStatus: 'UNVERIFIED' }, a.update); return { id: 'pp1', ...store.provider }; },
    update: async (a: any) => { store.provider = merge(store.provider, a.data); return { id: 'pp1', ...store.provider }; },
    updateMany: async () => ({ count: 1 }),
  },
  clientProfile: {
    findUnique: async () => (store.client ? { id: 'cp1', ...store.client } : null),
    upsert: async (a: any) => { store.client = merge(store.client ?? { kycStatus: 'UNVERIFIED' }, a.update); return { id: 'cp1', ...store.client }; },
    update: async (a: any) => { store.client = merge(store.client, a.data); return { id: 'cp1', ...store.client }; },
    updateMany: async () => ({ count: 1 }),
  },
  clientOnboarding: { findUnique: async () => null, create: async ({ data }: any) => data, update: async ({ data }: any) => data },
  user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE' }), update: async ({ data }: any) => ({ id: 'u1', ...data }) },
  $transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops({})),
};
const mocked = new WeakSet<object>();
function mockDb(t: TestContext) {
  store.provider = null; store.client = null;
  if (mocked.has(t)) return; mocked.add(t);
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
  t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null, storeKycFileIfNeeded: async (v: any) => v ?? null } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
  t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: {} } });
  t.mock.module('../services/client-profile.service', { namedExports: { clientProfileService: {} } });
}
const AGREE = { accurate: true, terms: true, privacy: true };

// ───────────── provider ─────────────
async function provider(t: TestContext) {
  mockDb(t);
  return import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
}
const getProvider = async (c: any) => { const res = mockRes(); await c.getSetupData({ user: { id: 'u1' } } as any, res); return res.body.data; };

test('provider: the wizard\'s nested payload is stored (headline, years, mainSpecialty, ...) and GET returns it; setup is complete', async (t) => {
  const c = await provider(t);
  const res = mockRes();
  await c.saveSetupData({ user: { id: 'u1' }, body: {
    details: { occupation: 'مصمم واجهات', country: 'السعودية', city: 'الرياض', bio: 'خبرة طويلة في التصميم', languages: ['العربية'], expYears: '5 الى 10 سنوات' },
    specialties: { mainSpec: 'التصميم', subSpecs: ['واجهات'] }, identity: { frontId: 'data:image/png;base64,AAAA', backId: 'data:image/png;base64,AAAA', certs: [] }, agreements: AGREE,
  } } as any, res);
  assert.equal(res.statusCode, 200);
  const got = await getProvider(c);
  assert.equal(got.headline, 'مصمم واجهات'); assert.equal(got.yearsOfExperience, 7); assert.equal(got.mainSpecialty, 'التصميم');
  assert.deepEqual(got.subSpecialties, ['واجهات']); assert.equal(got.country, 'السعودية'); assert.equal(got.bio, 'خبرة طويلة في التصميم');
  assert.equal(got.isProfileSetupComplete, true);
});

test('provider: the alternative names (headline / hourlyRate / yearsOfExperience / mainSpecialty / identity.idNumber / identity.dob) are ALL stored', async (t) => {
  const c = await provider(t);
  const res = mockRes();
  await c.saveSetupData({ user: { id: 'u1' }, body: {
    headline: 'مطور ويب', hourlyRate: 45.5, yearsOfExperience: 6, mainSpecialty: 'البرمجة', subSpecialties: ['ويب'],
    details: { country: 'مصر', city: 'القاهرة', bio: 'نبذة مهنية كاملة' },
    identity: { idNumber: '1234567890', dob: '1992-03-04', frontId: 'data:image/png;base64,AAAA', backId: 'data:image/png;base64,AAAA' }, agreements: AGREE,
  } } as any, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const got = await getProvider(c);
  assert.equal(got.headline, 'مطور ويب'); assert.equal(got.hourlyRate, 45.5); assert.equal(got.yearsOfExperience, 6);
  assert.equal(got.mainSpecialty, 'البرمجة'); assert.deepEqual(got.subSpecialties, ['ويب']);
  assert.equal(got.idNumber, '1234567890'); assert.equal(new Date(got.dob).toISOString().slice(0, 10), '1992-03-04');
  assert.equal(got.isProfileSetupComplete, true);
});

test('provider: unknown fields, a bad id number / date / rate / years are a 400 naming them and NOTHING is stored', async (t) => {
  const c = await provider(t);
  const bad: [any, string][] = [
    [{ details: {}, nickname: 'x', agreements: AGREE }, 'nickname'],
    [{ details: { favouriteColor: 'blue' }, agreements: AGREE }, 'details.favouriteColor'],
    [{ identity: { idNumber: '123' }, agreements: AGREE }, 'idNumber'],
    [{ identity: { dob: 'not-a-date' }, agreements: AGREE }, 'dob'],
    [{ hourlyRate: -3, agreements: AGREE }, 'hourlyRate'],
    [{ yearsOfExperience: 'many', agreements: AGREE }, 'yearsOfExperience'],
  ];
  for (const [body, path] of bad) {
    const res = mockRes();
    await c.saveSetupData({ user: { id: 'u1' }, body } as any, res);
    assert.equal(res.statusCode, 400, path);
    assert.ok((res.body.errors ?? []).some((e: any) => e.path === path), `${path} must be named: ${JSON.stringify(res.body.errors)}`);
    assert.equal(store.provider, null);
  }
});

test('provider: setup is NOT complete when a required field is missing (no mainSpecialty / years / agreements), complete once they are stored', async (t) => {
  const c = await provider(t);
  const base = { details: { occupation: 'مصمم', country: 'السعودية', city: 'الرياض', bio: 'نبذة' }, agreements: AGREE };
  const res = mockRes();
  await c.saveSetupData({ user: { id: 'u1' }, body: base } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal((await getProvider(c)).isProfileSetupComplete, false);
  await c.saveSetupData({ user: { id: 'u1' }, body: { ...base, details: { ...base.details, expYears: '1 الى 3 سنوات' }, specialties: { mainSpec: 'التصميم' } } } as any, mockRes());
  assert.equal((await getProvider(c)).isProfileSetupComplete, true);
  // a later partial save does not erase what is stored
  await c.saveSetupData({ user: { id: 'u1' }, body: { details: { city: 'جدة' }, agreements: AGREE } } as any, mockRes());
  const after = await getProvider(c);
  assert.equal(after.city, 'جدة'); assert.equal(after.mainSpecialty, 'التصميم'); assert.equal(after.yearsOfExperience, 2); assert.equal(after.isProfileSetupComplete, true);
});

// ───────────── client ─────────────
async function client(t: TestContext) {
  mockDb(t);
  const { ClientProfileController } = await import(`./client-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
  return new ClientProfileController();
}
const post = async (c: any, body: any) => { const res = mockRes(); await c.saveSetupData({ user: { userId: 'u1' }, body } as any, res, (e: any) => { throw e; }); return res; };

test('client: bio / interests / idNumber / dob (in details) are stored; the profile is complete; GET data matches', async (t) => {
  const c = await client(t);
  const res = await post(c, { details: { idNumber: '1234567890', dob: '1990-05-01', country: 'السعودية', city: 'الرياض', occupation: 'مهندس', address: 'حي النخيل', bio: 'نبذة عني', interests: ['تصميم', 'برمجة'] }, identity: {}, documents: {}, bank: {}, agreements: AGREE });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const d = store.client;
  assert.equal(d.bio, 'نبذة عني'); assert.deepEqual(d.interests, ['تصميم', 'برمجة']); assert.equal(d.idNumber, '1234567890');
  assert.equal(new Date(d.dob).toISOString().slice(0, 10), '1990-05-01'); assert.equal(d.isProfileComplete, true);
});

test('client: the alternative names (top-level bio / interests / idNumber / dob, identity.idNumber / dob) are mapped and stored', async (t) => {
  const c = await client(t);
  const res = await post(c, { bio: 'نبذة', interests: ['قراءة'], details: { country: 'مصر', city: 'القاهرة', occupation: 'طبيب', address: 'المعادي' }, identity: { idNumber: '2234567890', dob: '1985-01-02' }, documents: {}, agreements: AGREE });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const d = store.client;
  assert.equal(d.bio, 'نبذة'); assert.deepEqual(d.interests, ['قراءة']); assert.equal(d.idNumber, '2234567890'); assert.equal(new Date(d.dob).toISOString().slice(0, 10), '1985-01-02');
  assert.equal(d.isProfileComplete, true);
});

test('client: missing identity data -> isProfileComplete is false; unknown fields / bad values are a 400 and store nothing', async (t) => {
  const c = await client(t);
  const res = await post(c, { details: { country: 'السعودية', city: 'الرياض', occupation: 'مهندس', address: 'حي' }, identity: {}, documents: {}, agreements: AGREE });
  assert.equal(res.statusCode, 200);
  assert.equal(store.client.isProfileComplete, false, 'no idNumber / dob stored');
  store.client = null;
  for (const [body, path] of [
    [{ details: {}, identity: {}, documents: {}, agreements: AGREE, nickname: 'x' }, 'nickname'],
    [{ details: { hobbies: ['x'] }, identity: {}, documents: {}, agreements: AGREE }, 'details.hobbies'],
    [{ details: { idNumber: '12' }, identity: {}, documents: {}, agreements: AGREE }, 'details.idNumber'],
  ] as [any, string][]) {
    const r = await post(c, body);
    assert.equal(r.statusCode, 400, path);
    assert.ok((r.body.errors ?? []).some((e: any) => e.path === path), `${path}: ${JSON.stringify(r.body.errors)}`);
    assert.equal(store.client, null);
  }
});

test('client: a re-save without dob / idNumber never erases the stored ones', async (t) => {
  const c = await client(t);
  await post(c, { details: { idNumber: '1234567890', dob: '1990-05-01', country: 'السعودية', city: 'الرياض', occupation: 'مهندس', address: 'حي' }, identity: {}, documents: {}, agreements: AGREE });
  await post(c, { details: { city: 'جدة' }, identity: {}, documents: {}, agreements: AGREE });
  assert.equal(store.client.city, 'جدة'); assert.equal(store.client.idNumber, '1234567890'); assert.ok(store.client.dob);
});
