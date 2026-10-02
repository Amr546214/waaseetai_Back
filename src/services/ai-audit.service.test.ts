import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Business-model AI audit is disabled: no DB access/writes, no status change,
// no scores, no notification/email, creation is never blocked.

async function load(t: TestContext) {
  const boom = () => { throw new Error('must not be touched while AI audit is disabled'); };
  const trap = new Proxy({}, { get: boom });
  t.mock.module('../config/db', { namedExports: { prisma: trap } });
  t.mock.module('../socket', { namedExports: { getIO: boom } });
  t.mock.module('./notification.service', { namedExports: { notificationService: trap } });
  t.mock.module('./email.service', { namedExports: { emailService: trap } });
  const mod = await import(`./ai-audit.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return mod.aiAuditService as import('./ai-audit.service').AiAuditService;
}

test('auditProjectModel / triggerAuditAndPublish resolve without touching DB, status, notifications or email', async (t) => {
  const svc = await load(t);
  await svc.auditProjectModel('service-1', 'provider-1');
  await svc.triggerAuditAndPublish('service-1', 'provider-1');
});

test('executeAuditSync throws the AI_FEATURE_UNAVAILABLE 503 error and writes nothing', async (t) => {
  const svc = await load(t);
  await assert.rejects(() => svc.executeAuditSync('service-1', 'provider-1'), (e: any) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, 'AI_FEATURE_UNAVAILABLE');
    return true;
  });
});

test('ai-audit.service has no Gemini reference and never assigns a status or score', () => {
  const src = readFileSync(new URL('./ai-audit.service.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /gemini|prisma|aiScore|PUBLISHED|isApproved/i);
});

test('re-audit-all controller returns 503 with the unavailable code and does not read models', async (t) => {
  const boom = () => { throw new Error('must not query models'); };
  t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: boom }) } });
  const { MarketplaceServiceController } = await import(`../controllers/marketplace-service.controller.ts?fixture=${Date.now()}-${Math.random()}`) as any;
  const ctrl = new MarketplaceServiceController();
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  await ctrl.reAuditAllPendingModels({} as any, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AI_FEATURE_UNAVAILABLE');
});
