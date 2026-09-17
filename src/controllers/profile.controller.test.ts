import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileController } from './profile.controller';

// Phase 3D.1 final review, part 2: a missing req.user.activeRole must fail
// safely — never silently default to CLIENT, since that would pick an
// ambiguous/wrong role-profile write target. This is a plain unit test using
// manual req/res/next objects (no supertest/express server, no new test
// framework) since this project's tests are all Node:test unit tests, not
// HTTP integration tests. No prisma/db mocking is needed here: the guard
// throws before profileService is ever called.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

test('updateProfile: missing req.user.activeRole fails safely instead of defaulting to CLIENT', async () => {
  const req: any = {
    user: { userId: 'user-1', accountType: 'CLIENT_INDIVIDUAL' /* no activeRole */ },
    body: {}
  };
  const res = createMockRes();
  let passedError: any = null;
  const next = (err: any) => { passedError = err; };

  await profileController.updateProfile(req, res, next);

  assert.notEqual(passedError, null);
  assert.equal(passedError.statusCode, 401);
  assert.match(passedError.message, /الدور النشط/);
});

test('updateTab: missing req.user.activeRole fails safely instead of defaulting to CLIENT', async () => {
  const req: any = {
    user: { userId: 'user-1', accountType: 'CLIENT_INDIVIDUAL' /* no activeRole */ },
    params: { tabName: 'basics' },
    body: { firstName: 'X' }
  };
  const res = createMockRes();
  let passedError: any = null;
  const next = (err: any) => { passedError = err; };

  await profileController.updateTab(req, res, next);

  assert.notEqual(passedError, null);
  assert.equal(passedError.statusCode, 401);
  assert.match(passedError.message, /الدور النشط/);
});
