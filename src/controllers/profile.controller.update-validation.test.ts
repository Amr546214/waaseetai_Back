import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from './profile.controller';
import { profileService } from '../services/profile.service';

// PUT /profiles/update: an invalid body must be a structured 400 (not a 500),
// while a genuine service failure must still reach the error handler.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}
const reqWith = (body: any): any => ({ body, user: { userId: 'u1', activeRole: 'CLIENT' } });
const controller = new ProfileController();

test('an invalid update returns 400 (not 500) with success:false and an Arabic message', async (t) => {
  const update = t.mock.method(profileService, 'updateProfile', async () => ({}));
  const res = createMockRes();
  let nextErr: unknown = null;
  await controller.updateProfile(reqWith({ website: 'not-a-url', bio: 'x'.repeat(1001), firstName: 'س' }), res, (e?: unknown) => { nextErr = e; });
  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /[؀-ۿ]/);
  assert.equal(update.mock.callCount(), 0);
});

test('errors[] carries path/field/message/code and maps to form fields', async (t) => {
  t.mock.method(profileService, 'updateProfile', async () => ({}));
  const res = createMockRes();
  await controller.updateProfile(reqWith({ website: 'not-a-url', bio: 'x'.repeat(1001) }), res, () => {});
  const byField = Object.fromEntries(res.body.errors.map((e: any) => [e.field, e]));
  assert.equal(byField.website.message, 'رابط الموقع غير صحيح');
  assert.equal(byField.website.path, 'website');
  assert.ok(byField.website.code);
  assert.match(byField.bio.message, /1000/);
});

test('a wrong-typed field (number for a string) is also a 400 with that field named', async (t) => {
  t.mock.method(profileService, 'updateProfile', async () => ({}));
  const res = createMockRes();
  await controller.updateProfile(reqWith({ firstName: 12345 }), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.errors[0].field, 'firstName');
});

test('a valid update still succeeds (200) and reaches the service with the parsed data', async (t) => {
  const update = t.mock.method(profileService, 'updateProfile', async () => ({ ok: true }));
  const res = createMockRes();
  await controller.updateProfile(reqWith({ firstName: 'سارة', website: 'https://example.com', unknownKey: 1 }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(update.mock.calls[0].arguments.slice(0, 2), ['u1', 'CLIENT']);
  assert.equal((update.mock.calls[0].arguments[2] as any).firstName, 'سارة');
});

test('a real service failure is NOT turned into a 400: it goes to next() for the 500 handler', async (t) => {
  t.mock.method(profileService, 'updateProfile', async () => { throw new Error('db down'); });
  const res = createMockRes();
  let nextErr: any = null;
  await controller.updateProfile(reqWith({ firstName: 'سارة' }), res, (e?: unknown) => { nextErr = e; });
  assert.equal(res.statusCode, null);
  assert.equal(nextErr.message, 'db down');
});

test('several wrong fields in one request are ALL reported, each with field/path/message/code', async (t) => {
  t.mock.method(profileService, 'updateProfile', async () => ({}));
  const res = createMockRes();
  await controller.updateProfile(reqWith({ website: 'bad', linkedinUrl: 'bad', firstName: 1, hourlyRate: -5, skills: 'x' }), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.errors.map((e: any) => e.field).sort(), ['firstName', 'hourlyRate', 'linkedinUrl', 'skills', 'website']);
  for (const e of res.body.errors) for (const k of ['field', 'path', 'message', 'code']) assert.ok(e[k] !== undefined && e[k] !== '', `${e.field}.${k}`);
});

test('unknown / nested keys are stripped by the schema (200, not forwarded); a non-object body is a 400', async (t) => {
  const update = t.mock.method(profileService, 'updateProfile', async () => ({}));
  const res = createMockRes();
  await controller.updateProfile(reqWith({ firstName: 'سارة', unknownKey: 1, nested: { a: 1 } }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(update.mock.calls[0].arguments[2] as object), ['firstName']);
  const bad = createMockRes();
  await controller.updateProfile(reqWith('str'), bad, () => {});
  assert.equal(bad.statusCode, 400);
});
