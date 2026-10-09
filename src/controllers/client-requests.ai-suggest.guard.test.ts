import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// POST /client/requests/ai-suggest never drafts from nothing: an empty / too-short / generic input is a 400 and the AI service is NOT called.
async function load(t: TestContext) {
  const calls: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../socket', { namedExports: { getIO: () => null, ioInstance: null, initSocketServer: () => {} } });
  t.mock.module('../services/notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('../services/email.service', { namedExports: { emailService: {} } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
  t.mock.module('../services/project-progress.service', { namedExports: { projectProgressService: {} } });
  t.mock.module('../services/client-requests.service', { namedExports: { clientRequestsService: { generateAiSuggest: async (...a: any[]) => { calls.push(a); return { title: 'x' }; } } } });
  const mod = await import(`./client-requests.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  return { ctl: mod.clientRequestsController, calls };
}
async function run(ctl: any, body: any) {
  let error: any = null; let json: any = null;
  const res: any = { status: () => res, json: (b: any) => { json = b; return res; } };
  await ctl.aiSuggest({ body, user: { id: 'u1' } }, res, (e: any) => { error = e; });
  return { error, json };
}

test('ai-suggest: empty payload, generic title or short description -> 400 and no AI call', async (t) => {
  const { ctl, calls } = await load(t);
  for (const body of [{}, { title: 'تجربة', description: 'وصف طويل بما يكفي لعدة كلمات مفيدة جدا هنا' }, { title: 'تطبيق جوال للتوصيل', description: 'قصير' }]) {
    const r = await run(ctl, body);
    assert.equal(r.error?.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('ai-suggest: over-limit title (80) / description (2000) -> 400', async (t) => {
  const { ctl, calls } = await load(t);
  assert.equal((await run(ctl, { title: 'ع'.repeat(81), description: 'كلمة '.repeat(20) })).error?.statusCode, 400);
  assert.equal((await run(ctl, { title: 'تطبيق جوال للتوصيل', description: 'كلمة '.repeat(500) })).error?.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('ai-suggest: enough client-written context reaches the service', async (t) => {
  const { ctl, calls } = await load(t);
  const r = await run(ctl, { title: 'تطبيق جوال للتوصيل', description: 'أحتاج تطبيق جوال لتوصيل الطلبات يدعم تتبع السائق والدفع الإلكتروني' });
  assert.equal(r.error, null);
  assert.equal(calls.length, 1);
});
