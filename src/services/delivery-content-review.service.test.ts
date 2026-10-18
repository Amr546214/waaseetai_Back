import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

async function load(t: TestContext, mutate = (value: any) => value) {
  const calls: any[] = [], queries: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: { contract: { findFirst: async (query: any) => { queries.push(query); return {
    project: { id: 'owned-project', title: 'متجر', description: 'متجر إلكتروني', requirements: ['لوحة تحكم'] },
    stages: [{ title: 'الواجهة', description: 'مرحلة التصميم', deliveries: [{ note: 'أرفقت التصميم', submittedAt: new Date(),
      files: [JSON.stringify({ name: 'owned.ts', url: 'https://res.cloudinary.com/owned/file.ts' }), 'http://127.0.0.1/private'] }] }],
  }; } } } } });
  const { DeliveryReviewService } = await import(`./ai-features/delivery-review.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const svc = new DeliveryReviewService({ generateJson: async () => { throw new Error('legacy model must not be used'); } }, { enabled: () => true,
    client: { reviewDelivery: async (...args: any[]) => { calls.push(args); return mutate({ summary: 'قراءة جزئية للتصميم', contentRead: true, requirementsScope: 'PROJECT',
      met: [{ requirement: 'لوحة تحكم', evidence: 'dashboard', source: 'https://res.cloudinary.com/owned/file.ts' }], potentialGaps: [], questionsForReviewer: ['هل اختُبرت؟'],
      evidence: [{ source: 'https://res.cloudinary.com/owned/file.ts', sha256: 'a'.repeat(64), contentRead: true, excerpt: 'export function dashboard() {}', truncated: false, basis: 'FETCHED_TEXT' }],
      unavailable: [], execution: { status: 'UNAVAILABLE', executed: false, reason: 'لم يُشغّل كود' } }); } } });
  return { svc, calls, queries };
}
test('content review sends owned HTTPS files and project requirements, and reports actual read/execution basis', async t => {
  const { svc, calls, queries } = await load(t); const result = await svc.review('owner', 'owned-project', 'stage-1');
  assert.equal(result.contentRead, true); assert.equal(result.reviewedInputs.attachmentContent, true); assert.equal(result.execution?.executed, false);
  assert.equal(calls[0][0].files.length, 1); assert.deepEqual(calls[0][0].requirements, ['لوحة تحكم']); assert.equal(calls[0][0].requirementsScope, 'PROJECT');
  assert.deepEqual(queries[0].where.AND, [{ OR: [{ providerId: 'owner' }, { clientId: 'owner' }] }]);
});
test('content review rejects invented requirements, quotes and read/execution claims', async t => {
  for (const mutate of [
    (v: any) => ({ ...v, met: [{ ...v.met[0], requirement: 'دفع إلكتروني' }] }),
    (v: any) => ({ ...v, met: [{ ...v.met[0], evidence: 'not in the source' }] }),
    (v: any) => ({ ...v, contentRead: false }),
    (v: any) => ({ ...v, execution: { status: 'EXECUTED', executed: true, reason: 'fake' } }),
  ]) await t.test(mutate.toString().slice(0, 90), async child => { const { svc } = await load(child, mutate); await assert.rejects(svc.review('owner', 'owned-project', 'stage-1'), (error: any) => error.statusCode === 503); });
});
