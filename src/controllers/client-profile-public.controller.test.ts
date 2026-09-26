import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../utils/app-error';

// Implementation Batch 6 — client-profile.controller.ts#getPublicProfile.
// Public, unauthenticated route. Kept separate from the existing
// client-profile.controller.test.ts (setup-data fixtures) for clarity.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function loadController(t: TestContext, opts: { profile?: any; failure?: any } = {}) {
  const calls: any[] = [];
  t.mock.module('../services/client-profile.service', {
    namedExports: {
      clientProfileService: {
        getPublicProfile: async (id: string) => {
          calls.push(id);
          if (opts.failure) throw opts.failure;
          return opts.profile ?? { id, name: 'خالد العتيبي', stats: { completedProjects: 3 } };
        },
      },
    },
  });
  const { clientProfileController } = await import(`./client-profile.controller.ts?test=${Date.now()}-${Math.random()}`);
  return { clientProfileController, calls };
}

test('getPublicProfile: returns the real service result for a valid id', async t => {
  const { clientProfileController, calls } = await loadController(t);
  const req: any = { params: { id: 'client-1' } };
  const res = createMockRes();
  await clientProfileController.getPublicProfile(req, res, () => { throw new Error('next() should not be called on success'); });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(calls, ['client-1']);
});

test('getPublicProfile: an empty id is rejected before reaching the service', async t => {
  const { clientProfileController, calls } = await loadController(t);
  const req: any = { params: { id: '' } };
  const res = createMockRes();
  await clientProfileController.getPublicProfile(req, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('getPublicProfile: a non-client id (404 from the service) is forwarded as a real error', async t => {
  const { clientProfileController } = await loadController(t, { failure: new AppError('الملف الشخصي غير موجود', 404) });
  const req: any = { params: { id: 'not-a-client' } };
  const res = createMockRes();
  let error: any;
  await clientProfileController.getPublicProfile(req, res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 404);
});

test('route wiring: client public profile is registered before the authenticate guard, behind apiLimiter (no Gemini call, so no aiLimiter)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/client-profile.routes.ts'), 'utf8');
  const registration = "router.get('/public/:id', apiLimiter, clientProfileController.getPublicProfile);";
  assert.ok(source.includes(registration));
  assert.ok(source.indexOf(registration) < source.indexOf('router.use(authenticate)'));
  assert.doesNotMatch(registration, /aiLimiter/);
});
