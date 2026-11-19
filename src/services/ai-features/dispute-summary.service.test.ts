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

async function loadService(t: TestContext, opts: { dispute?: any; summarizeDispute?: (body: any) => Promise<any>; readFiles?: (refs: any[]) => Promise<any[]> }) {
  const findUniqueSpy = t.mock.fn(async () => (opts.dispute === undefined ? disputeFixture() : opts.dispute));
  const prismaMock: any = { dispute: { findUnique: findUniqueSpy } };
  t.mock.module('../../config/db', { namedExports: { prisma: prismaMock } });

  const summarizeSpy = t.mock.fn(opts.summarizeDispute ?? (async () => upstreamResponseFixture()));
  t.mock.module('../ai/waseet-ai/waseet-ai.client', {
    namedExports: { waseetAiClient: { summarizeDispute: summarizeSpy } },
  });

  const readSpy = t.mock.fn(opts.readFiles ?? (async (refs: any[]) => refs.map(ref => ({ ref, text: '', truncated: false, readable: false, reason: 'غير مهيأ في الاختبار' }))));
  t.mock.module('./dispute-evidence-reader', { namedExports: {
    readDisputeFiles: readSpy,
    mimeFromName: (name: string) => (/\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : undefined),
  } });
  const mod = await import(`./dispute-summary.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { disputeSummaryService: mod.disputeSummaryService, findUniqueSpy, summarizeSpy, readSpy, dropUnknownCitations: mod.dropUnknownCitations };
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


test('private case files and evidence links are read, each tagged, and unread ones say why — user ids never leave', async t => {
  const readFiles = async (refs: any[]) => refs.map((ref, i) => i === 0
    ? { ref, text: 'فاتورة بمبلغ 500 ريال', truncated: false, readable: true }
    : { ref, text: '', truncated: false, readable: false, reason: 'حجم الملف أكبر من 2 ميجابايت' });
  const { disputeSummaryService, summarizeSpy, readSpy } = await loadService(t, { readFiles, dispute: disputeFixture({
    evidence: ['https://res.cloudinary.com/demo/image/upload/proof.png'],
    attachments: [
      { ownerId: CLIENT_ID, name: 'invoice.pdf', mimeType: 'application/pdf', bytes: 1000, privateRef: 'ref-1' },
      { ownerId: PROVIDER_ID, name: 'big.pdf', mimeType: 'application/pdf', bytes: 9_000_000, privateRef: 'ref-2' },
    ] }) });
  await disputeSummaryService.generateSummary('dispute-101');
  const refs = readSpy.mock.calls[0].arguments[0];
  assert.deepEqual(refs.map((r: any) => [r.by, r.origin]), [['العميل', 'ملف نزاع'], ['مقدم الخدمة', 'ملف نزاع'], ['العميل', 'دليل مرفق بالنزاع']]);
  const sent = summarizeSpy.mock.calls[0].arguments[0];
  const joined = sent.evidenceList.join('\n');
  assert.match(joined, /\[F1\] ملف نزاع من العميل: «invoice\.pdf» — محتوى مقروء: فاتورة بمبلغ 500 ريال/);
  assert.match(joined, /\[F2\] ملف نزاع من مقدم الخدمة: «big\.pdf» — لم يُقرأ محتواه: حجم الملف أكبر من 2 ميجابايت/);
  assert.match(joined, /\[F3\] دليل مرفق بالنزاع/);
  assert.ok(!JSON.stringify(sent).includes(CLIENT_ID)); assert.ok(!JSON.stringify(sent).includes(PROVIDER_ID));
  assert.ok(!JSON.stringify(sent).includes('ref-1'));
});

test('the whole project chat and every dispute reply are sent, tagged, oldest first — no 4-message / 20-item cap', async t => {
  const base = Date.parse('2026-02-02T10:00:00.000Z');
  const chat = Array.from({ length: 80 }, (_, i) => ({ senderId: i % 2 ? PROVIDER_ID : CLIENT_ID, content: `رسالة نقاش رقم ${i + 1}`, createdAt: new Date(base + i * 1000) })).reverse();
  const replies = Array.from({ length: 12 }, (_, i) => ({ authorKind: 'PARTICIPANT', authorId: PROVIDER_ID, body: `رد المقدم ${i + 1}`, createdAt: new Date(base + i * 1000) })).reverse();
  const stages = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, stepOrder: i + 1, title: `مرحلة ${i + 1}`, status: 'PENDING', deliveries: [] }));
  const dispute = disputeFixture({ messages: replies, project: { id: 'p-1', contract: { clientId: CLIENT_ID, providerId: PROVIDER_ID, termsVersion: 1, signedAt: null, terms: null, projectConversation: { messages: chat }, amendments: [], stages } } });
  const { disputeSummaryService, summarizeSpy } = await loadService(t, { dispute });
  await disputeSummaryService.generateSummary('dispute-101');
  const sent = summarizeSpy.mock.calls[0].arguments[0];
  const chatLines = sent.evidenceList.filter((x: string) => /^\[C\d+\]/.test(x));
  assert.equal(chatLines.length, 80);
  assert.match(chatLines[0], /^\[C1\].*رسالة نقاش رقم 1$/);
  assert.match(chatLines[79], /^\[C80\].*رسالة نقاش رقم 80$/);
  assert.ok(sent.evidenceList.length > 20);
  for (let i = 1; i <= 12; i++) assert.match(sent.providerClaim, new RegExp(`\\[R${i}\\].*رد المقدم ${i}$`, 'm'));
});

test('when the record exceeds the size budget the OLDEST lines are dropped and the payload says so', async t => {
  const base = Date.parse('2026-02-02T10:00:00.000Z');
  const chat = Array.from({ length: 400 }, (_, i) => ({ senderId: CLIENT_ID, content: `${i + 1} ` + 'ك'.repeat(790), createdAt: new Date(base + i * 1000) })).reverse();
  const dispute = disputeFixture({ project: { id: 'p-1', contract: { clientId: CLIENT_ID, providerId: PROVIDER_ID, termsVersion: 1, signedAt: null, terms: null, projectConversation: { messages: chat }, amendments: [], stages: [] } } });
  const { disputeSummaryService, summarizeSpy } = await loadService(t, { dispute });
  await disputeSummaryService.generateSummary('dispute-101');
  const list: string[] = summarizeSpy.mock.calls[0].arguments[0].evidenceList;
  assert.match(list.join('\n'), /اختُصر السجل: حُذفت أقدم \d+ رسائل/);
  assert.ok(list.join('').length < 210_000);
  assert.match(list[list.length - 1], /^\[C\d+\] .* 400 /);
});

test('citations the payload never carried are removed from the model output; real ones stay', async t => {
  const dispute = disputeFixture({ messages: [{ authorKind: 'PARTICIPANT', authorId: CLIENT_ID, body: 'رد', createdAt: new Date() }] });
  const { disputeSummaryService } = await loadService(t, { dispute, summarizeDispute: async () => upstreamResponseFixture({ summary: 'ادعاء [R1] وآخر [R9] وملف [F4]', clientPerspective: 'عميل [R1]', providerPerspective: 'مقدم [C7]' }) });
  const out = await disputeSummaryService.generateSummary('dispute-101');
  assert.equal(out.summary, 'ادعاء [R1] وآخر وملف');
  assert.equal(out.clientPerspective, 'عميل [R1]');
  assert.equal(out.providerPerspective, 'مقدم');
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
  assert.match(sent.evidenceList.join('\n'), /نقاش المشروع.*\[C1\].*تقرير أسبوعي/s);
  assert.doesNotMatch(sent.contractTerms, /تقرير أسبوعي/);
  assert.doesNotMatch(JSON.stringify(sent), /files\.example\.test|ملاحظة غير مصرح بها|رسالة خارج أطراف النزاع|محادثة طرف ثالث|تعديل غير مطبّق/);
});
