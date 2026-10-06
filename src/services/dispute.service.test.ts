import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Advisory-only dispute AI summary (generateAiSummary), served exclusively by
// WaseetAI POST /v1/ai/disputes/summary. `prisma` (via ../config/db) and the
// WaseetAI client are mocked; no real DB/network call ever happens. These
// tests prove the feature is read-only, never resolves/rejects the dispute,
// sends minimal data, never surfaces the upstream `recommendation`, and
// never lets a malformed response through.

const CLIENT_ID = 'user-client';
const PROVIDER_ID = 'user-provider';

function disputeFixture(overrides: Partial<any> = {}) {
  return {
    id: 'dispute-1',
    openedById: CLIENT_ID,
    reason: 'التسليم غير مطابق للاتفاق',
    description: 'المقدم لم يسلم المرحلة الثانية في الموعد المتفق عليه',
    evidence: ['https://cdn.example.com/private-evidence1.png'],
    status: 'OPEN',
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    request: { id: 'req-1', clientProfile: { userId: CLIENT_ID } },
    project: null,
    ...overrides,
  };
}

function upstreamFixture(overrides: Partial<any> = {}) {
  return {
    summary: 'ملخص محايد لموضوع النزاع.',
    clientPerspective: 'وجهة نظر العميل.',
    providerPerspective: 'وجهة نظر مقدم الخدمة.',
    recommendation: 'تسوية مقترحة يجب ألا تصل إلى الأدمن.',
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: { dispute?: any; summarizeDispute?: (body: any) => Promise<any> }) {
  const findUniqueSpy = t.mock.fn(async () => (opts.dispute === undefined ? disputeFixture() : opts.dispute));
  // Deliberately NO update/create functions: any write attempt would throw.
  const prismaMock: any = { dispute: { findUnique: findUniqueSpy } };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const summarizeSpy = t.mock.fn(opts.summarizeDispute ?? (async () => { throw new Error('summarizeDispute not stubbed for this test'); }));
  t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: { summarizeDispute: summarizeSpy } } });

  const mod = await import(`./dispute.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { disputeService: mod.disputeService, findUniqueSpy, summarizeSpy };
}

test('generateAiSummary: returns only summary/clientPerspective/providerPerspective and drops recommendation', async (t) => {
  const { disputeService, findUniqueSpy } = await loadService(t, { summarizeDispute: async () => upstreamFixture() });

  const result = await disputeService.generateAiSummary('dispute-1');

  assert.deepEqual(result, {
    summary: 'ملخص محايد لموضوع النزاع.',
    clientPerspective: 'وجهة نظر العميل.',
    providerPerspective: 'وجهة نظر مقدم الخدمة.',
  });
  assert.equal('recommendation' in result, false);
  assert.equal(findUniqueSpy.mock.calls.length, 1, 'reads the dispute exactly once, no writes');
});

test('generateAiSummary: a client-opened dispute puts the claim on the client side only', async (t) => {
  const { disputeService, summarizeSpy } = await loadService(t, { summarizeDispute: async () => upstreamFixture() });
  await disputeService.generateAiSummary('dispute-1');

  const body = summarizeSpy.mock.calls[0].arguments[0];
  assert.match(body.clientClaim, /التسليم غير مطابق للاتفاق/);
  assert.match(body.providerClaim, /لا يوجد ادعاء مسجل/);
});

test('generateAiSummary: a provider-opened dispute puts the claim on the provider side only', async (t) => {
  const { disputeService, summarizeSpy } = await loadService(t, {
    dispute: disputeFixture({ openedById: PROVIDER_ID }),
    summarizeDispute: async () => upstreamFixture(),
  });
  await disputeService.generateAiSummary('dispute-1');

  const body = summarizeSpy.mock.calls[0].arguments[0];
  assert.match(body.providerClaim, /التسليم غير مطابق للاتفاق/);
  assert.match(body.clientClaim, /لا يوجد ادعاء مسجل/);
});

test('generateAiSummary: sends minimal data — no names, attachment URLs, stage descriptions or delivery notes', async (t) => {
  const { disputeService, summarizeSpy } = await loadService(t, {
    dispute: disputeFixture({
      request: null,
      project: {
        id: 'proj-1',
        contract: {
          clientId: CLIENT_ID,
          stages: [{ stepOrder: 1, title: 'المرحلة الأولى', description: 'وصف سري', status: 'APPROVED', deliveries: [{ note: 'ملاحظة تسليم سرية', status: 'APPROVED' }] }],
        },
      },
    }),
    summarizeDispute: async () => upstreamFixture(),
  });
  await disputeService.generateAiSummary('dispute-1');

  const body = summarizeSpy.mock.calls[0].arguments[0];
  const sent = JSON.stringify(body);
  assert.equal(body.projectId, 'proj-1');
  assert.match(sent, /المرحلة الأولى/);
  assert.doesNotMatch(sent, /cdn\.example\.com/);
  assert.doesNotMatch(sent, /وصف سري|ملاحظة تسليم سرية/);
  assert.match(body.evidenceList[0], /1 مرفق/);
});

test('generateAiSummary: throws 404 for a missing dispute without calling WaseetAI', async (t) => {
  const { disputeService, summarizeSpy } = await loadService(t, { dispute: null });
  await assert.rejects(() => disputeService.generateAiSummary('missing'), (e: any) => e.statusCode === 404);
  assert.equal(summarizeSpy.mock.calls.length, 0);
});

test('generateAiSummary: refuses (422) when the client party cannot be determined, without calling WaseetAI', async (t) => {
  const { disputeService, summarizeSpy } = await loadService(t, { dispute: disputeFixture({ request: null, project: null }) });
  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), (e: any) => e.statusCode === 422);
  assert.equal(summarizeSpy.mock.calls.length, 0);
});

test('generateAiSummary: propagates an honest error when WaseetAI fails (no fabricated summary)', async (t) => {
  const { disputeService } = await loadService(t, { summarizeDispute: async () => { throw new Error('WaseetAI unavailable'); } });
  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), /WaseetAI unavailable/);
});

test('generateAiSummary: rejects a response missing a required perspective', async (t) => {
  const { disputeService } = await loadService(t, { summarizeDispute: async () => upstreamFixture({ providerPerspective: undefined }) });
  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), (e: any) => e.code === 'INVALID_RESPONSE');
});

test('generateAiSummary: rejects an oversized field', async (t) => {
  const { disputeService } = await loadService(t, { summarizeDispute: async () => upstreamFixture({ summary: 'x'.repeat(5000) }) });
  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), (e: any) => e.code === 'INVALID_RESPONSE');
});

test('generateAiSummary: rejects any verdict/fault/money field in the response', async (t) => {
  const { disputeService } = await loadService(t, { summarizeDispute: async () => upstreamFixture({ winner: 'client', faultPercentage: 80 }) });
  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), (e: any) => e.code === 'INVALID_RESPONSE');
});


// ── BE-1: GET /provider|client/disputes/:id exposes heldEscrowAmount (read-only) ──

test('heldEscrowAmount: the escrow balance still held, using the provider-finance definition', async (t) => {
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  const { heldEscrowAmount } = await import(`./dispute.service.ts?fixture=${Date.now()}-${Math.random()}`);
  assert.equal(heldEscrowAmount(null, 100), null);
  assert.equal(heldEscrowAmount(undefined, 100), null);
  assert.equal(heldEscrowAmount({ amount: 113, releasedAmount: 40, status: 'HELD' }, 100), 60); // price 100 − released 40 (fees are not part of it)
  assert.equal(heldEscrowAmount({ amount: 113, releasedAmount: 0, status: 'HELD' }, null), 113); // no contract price -> escrow amount
  assert.equal(heldEscrowAmount({ amount: 113, releasedAmount: 130, status: 'HELD' }, 100), 0); // never negative
  assert.equal(heldEscrowAmount({ amount: 113, releasedAmount: 100, status: 'RELEASED' }, 100), 0);
  assert.equal(heldEscrowAmount({ amount: 113, releasedAmount: 0, status: 'REFUNDED' }, 100), 0);
  assert.equal(heldEscrowAmount({ amount: 10, releasedAmount: 0.005, status: 'HELD' }, 33.333), 33.33); // 2 decimals
});

test('getForUser: adds heldEscrowAmount from the escrow of the dispute project; null without a project', async (t) => {
  const escrowFind = t.mock.fn(async (_args: any) => ({ amount: 113, releasedAmount: 40, status: 'HELD', project: { contract: { price: 100 } } }));
  let dispute: any = { id: 'd1', openedById: 'u1', againstUserId: 'u2', projectId: 'p1', status: 'OPEN' };
  const prismaMock: any = { dispute: { findUnique: async () => dispute }, escrow: { findUnique: escrowFind } };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { disputeService } = await import(`./dispute.service.ts?fixture=${Date.now()}-${Math.random()}`);

  const withProject = await disputeService.getForUser('d1', 'u1');
  assert.equal(withProject.heldEscrowAmount, 60);
  assert.equal(withProject.id, 'd1');
  assert.deepEqual(escrowFind.mock.calls[0].arguments[0].where, { projectId: 'p1' });

  dispute = { ...dispute, projectId: null };
  const without = await disputeService.getForUser('d1', 'u2');
  assert.equal(without.heldEscrowAmount, null);
  assert.equal(escrowFind.mock.callCount(), 1, 'no escrow lookup without a project');

  await assert.rejects(() => disputeService.getForUser('d1', 'stranger'), (e: any) => e.statusCode === 403);
});
