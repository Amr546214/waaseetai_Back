import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Delivery AI review is disabled until WaseetAI supports it: the service
// method throws AI_FEATURE_UNAVAILABLE without any DB access, and the manual
// delivery workflow methods remain exposed on the same service.

async function load(t: TestContext) {
  const boom = () => { throw new Error('database must not be touched'); };
  t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: boom }) } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });
  t.mock.module('./affiliate-commission.service', { namedExports: { createCommissionsForStageReleaseEvent: async () => undefined } });
  const { projectProgressService } = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return projectProgressService;
}

test('getDeliveryAiReview: throws the 503 AI_FEATURE_UNAVAILABLE error with no DB access', async (t) => {
  const svc = await load(t);
  await assert.rejects(() => svc.getDeliveryAiReview('user-1', 'contract-1', 'stage-1'), (e: any) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, 'AI_FEATURE_UNAVAILABLE');
    return true;
  });
});

test('normal delivery workflow methods are still present (stages, deliveries, approvals untouched)', async (t) => {
  const svc = await load(t);
  assert.equal(typeof svc.reviewDelivery, 'function');
  assert.equal(typeof svc.submitDelivery, 'function');
  assert.equal(typeof svc.getProjectProgress, 'function');
});
