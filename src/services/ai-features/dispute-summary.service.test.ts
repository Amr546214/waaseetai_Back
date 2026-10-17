import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_ID = 'user-client-1';
const PROVIDER_ID = 'user-provider-1';

function disputeFixture(overrides: Partial<any> = {}) {
  return {
    id: 'dispute-101',
    openedById: CLIENT_ID,
    reason: 'تأخر في التسليم',
    description: 'لم يتم تسليم متطلبات المرحلة الأولى في الوقت المحدد',
    evidence: ['https://cdn.example.com/evidence1.png'],
    status: 'OPEN',
    createdAt: new Date('2026-02-01T10:00:00.000Z'),
    request: { id: 'req-1', clientProfile: { userId: CLIENT_ID } },
    project: null,
    ...overrides,
  };
}

function upstreamResponseFixture(overrides: Partial<any> = {}) {
  return {
    summary: 'ملخص موضوع النزاع بشأن مواعيد التسليم.',
    clientPerspective: 'العميل يطالب بالالتزام بالموعد أو استرجاع الدفعة.',
    providerPerspective: 'مقدم الخدمة طلب وقتاً إضافياً بسبب تعديل المتطلبات.',
    recommendation: 'تسوية مقترحة غير معلنة.',
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: { dispute?: any; summarizeDispute?: (body: any) => Promise<any> }) {
  const findUniqueSpy = t.mock.fn(async () => (opts.dispute === undefined ? disputeFixture() : opts.dispute));
  const prismaMock: any = { dispute: { findUnique: findUniqueSpy } };
  t.mock.module('../../config/db', { namedExports: { prisma: prismaMock } });

  const summarizeSpy = t.mock.fn(opts.summarizeDispute ?? (async () => upstreamResponseFixture()));
  t.mock.module('../ai/waseet-ai/waseet-ai.client', {
    namedExports: { waseetAiClient: { summarizeDispute: summarizeSpy } },
  });

  const mod = await import(`./dispute-summary.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { disputeSummaryService: mod.disputeSummaryService, findUniqueSpy, summarizeSpy };
}

test('generateSummary: calls Waseet AI summarizeDispute and strips forbidden recommendation field', async (t) => {
  const { disputeSummaryService, findUniqueSpy, summarizeSpy } = await loadService(t, {});

  const result = await disputeSummaryService.generateSummary('dispute-101');

  assert.deepEqual(result, {
    summary: 'ملخص موضوع النزاع بشأن مواعيد التسليم.',
    clientPerspective: 'العميل يطالب بالالتزام بالموعد أو استرجاع الدفعة.',
    providerPerspective: 'مقدم الخدمة طلب وقتاً إضافياً بسبب تعديل المتطلبات.',
  });
  assert.equal('recommendation' in (result as any), false);
  assert.equal(findUniqueSpy.mock.calls.length, 1);
  assert.equal(summarizeSpy.mock.calls.length, 1);
});

test('generateSummary: formats client claims and no-claim provider correctly', async (t) => {
  const { disputeSummaryService, summarizeSpy } = await loadService(t, {});

  await disputeSummaryService.generateSummary('dispute-101');

  const sentBody = summarizeSpy.mock.calls[0].arguments[0];
  assert.equal(sentBody.disputeId, 'dispute-101');
  assert.match(sentBody.clientClaim, /تأخر في التسليم/);
  assert.match(sentBody.providerClaim, /لا يوجد ادعاء مسجل/);
});

test('generateFromPayload: rejects responses containing forbidden verdict keys', async (t) => {
  const { disputeSummaryService } = await loadService(t, {
    summarizeDispute: async () => ({
      summary: 'ملخص',
      clientPerspective: 'عميل',
      providerPerspective: 'مقدم',
      verdict: 'مذنب', // forbidden key
    }),
  });

  await assert.rejects(
    disputeSummaryService.generateFromPayload({
      disputeId: 'd-1',
      projectId: 'p-1',
      clientClaim: 'c',
      providerClaim: 'p',
      evidenceList: [],
    }),
    (err: any) => err.code === 'INVALID_RESPONSE'
  );
});
