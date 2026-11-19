import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_ID = 'user-client-1';
const PROVIDER_ID = 'user-provider-1';

function disputeFixture(overrides: Partial<any> = {}) {
  return {
    id: 'dispute-101',
    openedById: CLIENT_ID,
    againstUserId: PROVIDER_ID,
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


test('new private evidence is counted by party without forwarding names, references or file contents to AI', async t => {
  const {disputeSummaryService, summarizeSpy} = await loadService(t, {dispute: disputeFixture({attachments:[{ownerId:CLIENT_ID},{ownerId:PROVIDER_ID}]})});
  await disputeSummaryService.generateSummary('dispute-101');
  const sent = summarizeSpy.mock.calls[0].arguments[0];
  assert.ok(sent.evidenceList.some((x: string)=>x.includes('إضافية مقدمة من العميل')));
  assert.ok(sent.evidenceList.some((x: string)=>x.includes('إضافية مقدمة من مقدم الخدمة')));
  assert.ok(!JSON.stringify(sent).includes(CLIENT_ID)); assert.ok(!JSON.stringify(sent).includes(PROVIDER_ID));
});

test('dispute summary sends saved terms, applied changes, delivery dates and the other party’s replies', async t => {
  const at = new Date('2026-02-02T10:00:00.000Z');
  const dispute = disputeFixture({
    stageId: 'stage-1',
    messages: [
      { authorKind: 'PARTICIPANT', authorId: PROVIDER_ID, body: 'التسليم النهائي فقط؛ راجع https://files.example.test/private', createdAt: at },
      { authorKind: 'STAFF', authorId: PROVIDER_ID, body: 'ملاحظة غير مصرح بها', createdAt: at },
      { authorKind: 'PARTICIPANT', authorId: 'outsider', body: 'رسالة خارج أطراف النزاع', createdAt: at },
    ],
    project: { id: 'p-1', contract: {
      clientId: CLIENT_ID, providerId: PROVIDER_ID, termsVersion: 3, signedAt: at,
      terms: { offerTerms: { deliverables: 'تقرير نهائي واحد' } },
      projectConversation: { messages: [
        { senderId: CLIENT_ID, content: 'هل يمكن الاتفاق على تقرير أسبوعي؟', createdAt: at },
        { senderId: 'outsider', content: 'محادثة طرف ثالث', createdAt: at },
      ] },
      amendments: [
        { type: 'SCOPE', title: 'تعديل ناجز', description: 'إضافة جدول', appliedAt: at },
        { type: 'SCOPE', title: 'تعديل غير مطبّق', appliedAt: null },
      ],
      stages: [{ id: 'stage-1', stepOrder: 1, title: 'التقرير', status: 'SUBMITTED', deliveries: [{ status: 'SUBMITTED', submittedAt: at }] }],
    } },
  });
  const { disputeSummaryService, summarizeSpy } = await loadService(t, { dispute });
  await disputeSummaryService.generateSummary('dispute-101');
  const sent = summarizeSpy.mock.calls[0].arguments[0];
  assert.match(sent.providerClaim, /التسليم النهائي فقط/);
  assert.match(sent.contractTerms, /نسخة الشروط المحفوظة: 3.*تقرير نهائي واحد/s);
  assert.match(sent.evidenceList.join('\n'), /تعديل ناجز.*إضافة جدول.*محل النزاع.*2026-02-02T10:00:00/s);
  assert.match(sent.evidenceList.join('\n'), /نقاش المشروع.*تقرير أسبوعي/);
  assert.doesNotMatch(sent.contractTerms, /تقرير أسبوعي/);
  assert.doesNotMatch(JSON.stringify(sent), /files\.example\.test|ملاحظة غير مصرح بها|رسالة خارج أطراف النزاع|محادثة طرف ثالث|تعديل غير مطبّق/);
});
