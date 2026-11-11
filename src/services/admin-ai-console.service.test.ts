import assert from 'node:assert/strict';
import { test } from 'node:test';

test('AI console projects saved metrics only and never exports prompts, raw responses or identities', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  const { AdminAiConsoleService } = await import('./admin-ai-console.service');
  const at = new Date('2026-11-01T00:00:00Z');
  const selects: Record<string, unknown>[] = [];
  const db = {
    $transaction: (queries: unknown[]) => Promise.all(queries),
    aiAuditLog: {
      aggregate: async () => ({ _count: { id: 2 }, _sum: { totalTokens: 30 }, _avg: { latencyMs: 120 } }),
      count: async () => 1,
      groupBy: async () => [{ modelVersion: 'stored-model', _count: { id: 2 } }],
      findMany: async (args: Record<string, unknown>) => { selects.push(args.select as Record<string, unknown>); return Array.from({ length: 21 }, (_, n) => ({
        id: String(n), providerSpecialtyId: 'ref', modelVersion: 'stored-model', totalTokens: 3, latencyMs: 4, createdAt: at,
        rawRequest: 'must-not-leak', rawResponse: 'must-not-leak', errorMessage: 'must-not-leak',
      })); },
    },
    aiAccreditationAuditLog: {
      count: async () => 3,
      findMany: async (args: Record<string, unknown>) => { selects.push(args.select as Record<string, unknown>); return [{
        id: 'a', accreditationSubmissionId: 'ref', evaluatedAt: at, promptTokensUsed: null, completionTokensUsed: null, rawAiResponse: 'must-not-leak',
      }]; },
    },
    proposal: {
      count: async () => 4,
      aggregate: async () => ({ _count: { id: 1 }, _avg: { aiMatchScore: 0 }, _min: { aiMatchScore: 0 }, _max: { aiMatchScore: 0 } }),
      findMany: async () => [{ id: 'p', clientRequestId: 'r', projectId: null, aiMatchScore: 0, createdAt: at, coverLetter: 'must-not-leak' }],
    },
  };
  const service = new AdminAiConsoleService(db as never, () => new Date('2026-11-11T00:00:00Z'));
  const overview = await service.overview(30);
  assert.equal(overview.specialtyChecks, 2);
  assert.equal(overview.recordedErrors, 1);
  assert.equal(overview.scoredOffers, 4);
  const page = await service.audit(30, 1, 'specialty');
  assert.equal(page.items.length, 20);
  assert.equal(page.hasNext, true);
  const accreditation = await service.audit(30, 1, 'accreditation');
  assert.equal(accreditation.items[0].tokens, null);
  const matches = await service.matching(30, 1);
  assert.equal(matches.average, 0);
  assert.equal(matches.items[0].score, 0);
  for (const output of [overview, page, accreditation, matches]) assert.ok(!JSON.stringify(output).includes('must-not-leak'));
  for (const select of selects) for (const key of ['rawRequest', 'rawResponse', 'rawAiResponse', 'errorMessage']) assert.ok(!(key in select));
});
