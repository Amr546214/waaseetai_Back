import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { AccountType } from '@prisma/client';

async function load(t: TestContext, accountType = AccountType.PROVIDER_INDIVIDUAL, opts: { failure?: boolean; skills?: any[] } = {}) {
  const calls: any[] = [];
  const saves: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: {
    user: { findUnique: async () => ({ id: 'authenticated-provider', accountType, status: 'ACTIVE', roles: [], activeRole: null }), update: async () => ({}) },
    providerProfile: {
      findUnique: async () => ({ id: 'profile', skills: [], portfolioItems: [] }),
      upsert: async (args: any) => { saves.push(args); return { id: 'profile' }; },
      update: async () => ({}),
      updateMany: async () => ({ count: 0 })
    },
    skill: { findMany: async () => opts.skills ?? [{ id: 'real-css-id', name: 'CSS' }] },
    $transaction: async (ops: any[]) => Promise.all(ops)
  } } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 'session' }) } } });
  t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (value: any) => value, storeKycFileIfNeeded: async (value: any) => value } });
  const service: any = {};
  for (const method of ['suggestBio', 'suggestSkills']) service[method] = async (...args: any[]) => {
    calls.push([method, ...args]);
    if (opts.failure) throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
    return method === 'suggestBio' ? { suggestedBio: 'نبذة مقترحة' } : { suggestedSkills: ['CSS'] };
  };
  t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: service } });
  const controller = await import(`./provider-profile.controller.ts?test=${Date.now()}-${Math.random()}`);
  const auth = await import(`../middlewares/auth.middleware.ts?test=${Date.now()}-${Math.random()}`);
  const res: any = { statusCode: 200, body: null, status(n: number) { this.statusCode = n; return this; }, json(body: any) { this.body = body; return this; } };
  return { controller, auth, calls, saves, res };
}

for (const method of ['suggestBio', 'suggestSkills'] as const) {
  test(`${method}: authenticated provider success through real auth/active/role guards`, async t => {
    const x = await load(t);
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'batch4-test-only-secret';
    t.after(() => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });
    const req: any = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'authenticated-provider' }, process.env.JWT_SECRET)}` }, get: () => '', body: { jobTitle: 'مصمم' } };
    let error: any;
    await x.auth.authenticate(req, x.res, (e: any) => { error = e; });
    assert.equal(error, undefined);
    x.auth.requireActiveUser(req, x.res, (e: any) => { error = e; });
    assert.equal(error, undefined);
    x.auth.authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)(req, x.res, (e: any) => { error = e; });
    assert.equal(error, undefined);
    await x.controller[method](req, x.res, (e: any) => { error = e; });
    assert.equal(error, undefined);
    assert.equal(x.res.body.success, true);
    assert.deepEqual(x.calls[0], [method, 'authenticated-provider', { jobTitle: 'مصمم' }]);
    assert.equal(x.saves.length, 0);
  });

  test(`${method}: non-provider forbidden; no generation`, async t => {
    const x = await load(t, AccountType.CLIENT_INDIVIDUAL);
    const req: any = { user: { id: 'client', accountType: AccountType.CLIENT_INDIVIDUAL, roles: ['CLIENT'], activeRole: 'CLIENT' } };
    let error: any;
    x.auth.authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)(req, x.res, (e: any) => { error = e; });
    assert.equal(error.statusCode, 403);
    assert.equal(x.calls.length, 0);
  });

  test(`${method}: unauthenticated rejected and identity injection rejected`, async t => {
    const x = await load(t);
    await x.controller[method]({ body: {} } as any, x.res, () => {});
    assert.equal(x.res.statusCode, 401);
    await x.controller[method]({ user: { id: 'owner' }, body: { userId: 'victim' } } as any, x.res, () => {});
    assert.equal(x.res.statusCode, 400);
    assert.equal(x.calls.length, 0);
  });

  test(`${method}: provider errors forwarded without fake response`, async t => {
    const x = await load(t, AccountType.PROVIDER_INDIVIDUAL, { failure: true });
    let error: any;
    await x.controller[method]({ user: { id: 'owner' }, body: {} } as any, x.res, (e: any) => { error = e; });
    assert.equal(error.statusCode, 503);
    assert.equal(x.res.body, null);
  });
}

test('route wiring: both suggestions are behind authenticate, active status, provider role and aiLimiter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/provider-profile.routes.ts'), 'utf8');
  for (const endpoint of ['bio', 'skills']) {
    const registration = `router.post('/suggest-${endpoint}', requireProvider, aiLimiter, providerProfileController.suggest${endpoint === 'bio' ? 'Bio' : 'Skills'});`;
    assert.ok(source.includes(registration));
    assert.ok(source.indexOf('router.use(authenticate, requireActiveUser)') < source.indexOf(registration));
  }
});

test('ordinary setup save connects only real taxonomy IDs and preserves existing skills (no set/delete/upsert of taxonomy)', async t => {
  const x = await load(t);
  await x.controller.saveSetupData({ user: { id: 'owner' }, body: { skills: ['CSS'] } } as any, x.res);
  assert.equal(x.res.statusCode, 200);
  assert.deepEqual(x.saves[0].update.skills, { connect: [{ id: 'real-css-id' }] });
  assert.deepEqual(x.saves[0].create.skills, { connect: [{ id: 'real-css-id' }] });
});

test('ordinary setup save rejects unknown names before any writes', async t => {
  const x = await load(t, AccountType.PROVIDER_INDIVIDUAL, { skills: [] });
  await x.controller.saveSetupData({ user: { id: 'owner' }, body: { skills: ['Invented Skill'] } } as any, x.res);
  assert.equal(x.res.statusCode, 400);
  assert.equal(x.saves.length, 0);
});
