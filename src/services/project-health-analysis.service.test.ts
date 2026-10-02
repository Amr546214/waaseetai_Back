import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Project health analysis is disabled until WaseetAI supports it: the service
// method throws AI_FEATURE_UNAVAILABLE without touching the database, and
// fabricates nothing.

async function load(t: TestContext) {
  const boom = () => { throw new Error('database must not be touched'); };
  t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: boom }) } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });
  t.mock.module('./affiliate-commission.service', { namedExports: { createCommissionsForStageReleaseEvent: async () => undefined } });
  const { projectProgressService } = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return projectProgressService;
}

test('getProjectHealthAnalysis: throws the 503 AI_FEATURE_UNAVAILABLE error with no DB access', async (t) => {
  const svc = await load(t);
  await assert.rejects(() => svc.getProjectHealthAnalysis('user-1', 'contract-1'), (e: any) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, 'AI_FEATURE_UNAVAILABLE');
    assert.match(e.message, /WaseetAI/);
    return true;
  });
});

test('project-progress.service has no Gemini reference', () => {
  const src = readFileSync(new URL('./project-progress.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gemini|generateStructured/i);
});
