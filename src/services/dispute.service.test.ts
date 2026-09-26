import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 2, Part B — advisory-only dispute AI summary
// (generateAiSummary). `prisma` (via ../config/db) and `geminiClient` are
// both mocked; no real DB/network call ever happens. These tests prove the
// feature is read-only (no update/create write path is ever exercised),
// never resolves/rejects the dispute, and never lets a fabricated or
// out-of-bounds Gemini response through.

function disputeFixture(overrides: Partial<any> = {}) {
  return {
    id: 'dispute-1',
    reason: 'التسليم غير مطابق للاتفاق',
    description: 'المقدم لم يسلم المرحلة الثانية في الموعد المتفق عليه',
    evidence: ['https://cdn.example.com/evidence1.png'],
    status: 'OPEN',
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    request: { title: 'تصميم هوية بصرية', description: 'وصف حقيقي للطلب' },
    project: null,
    openedBy: { firstName: 'محمد', lastName: 'العمري' },
    againstUser: { firstName: 'خالد', lastName: 'الغامدي' },
    ...overrides,
  };
}

function validSummaryFixture(overrides: Partial<any> = {}) {
  return {
    caseSummary: 'ملخص محايد لموضوع النزاع بناءً على البيانات المرفقة فقط.',
    timelineSummary: 'تسلسل زمني موجز لمراحل الطلب حتى فتح النزاع.',
    evidenceSummary: ['رابط دليل واحد مرفق من الطرف الذي فتح النزاع.'],
    evidenceGaps: ['لا يوجد دليل واضح على تاريخ التسليم الفعلي.'],
    suggestedQuestions: ['هل تم إرسال أي تواصل بخصوص التأخير؟'],
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: {
  dispute?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const findUniqueSpy = t.mock.fn(async () => (opts.dispute === undefined ? disputeFixture() : opts.dispute));
  // Deliberately NO update/create functions on the mock — if the code under
  // test ever tried to write, calling a missing method would throw and the
  // test would fail loudly, proving generateAiSummary performs zero writes.
  const prismaMock: any = {
    dispute: { findUnique: findUniqueSpy },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); }),
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./dispute.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { disputeService: mod.disputeService, findUniqueSpy };
}

test('generateAiSummary: a genuine validated Gemini success is returned as-is, with zero DB writes', async (t) => {
  const summary = validSummaryFixture();
  const { disputeService, findUniqueSpy } = await loadService(t, {
    generateStructured: async (prompt: string, options: any) => {
      assert.equal(options.validate(summary), true, 'the real validator must accept well-formed advisory output');
      assert.match(prompt, /التسليم غير مطابق للاتفاق/, 'the real dispute reason must reach the prompt');
      return { data: summary, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    },
  });

  const result = await disputeService.generateAiSummary('dispute-1');

  assert.deepEqual(result, summary);
  assert.equal(findUniqueSpy.mock.calls.length, 1, 'reads the dispute exactly once');
});

test('generateAiSummary: evidence links are presented as unreviewed references, never claimed as fetched', async (t) => {
  let capturedPrompt = '';
  await (
    await loadService(t, {
      generateStructured: async (prompt: string, options: any) => {
        capturedPrompt = prompt;
        return { data: validSummaryFixture(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    })
  ).disputeService.generateAiSummary('dispute-1');

  assert.match(capturedPrompt, /مراجع فقط، لم يتم فتح أو فحص محتواها/);
});

test('generateAiSummary: throws 404 for a dispute that does not exist, without ever calling Gemini', async (t) => {
  let geminiCalled = false;
  const { disputeService } = await loadService(t, {
    dispute: null,
    generateStructured: async () => {
      geminiCalled = true;
      throw new Error('should never be reached');
    },
  });

  await assert.rejects(() => disputeService.generateAiSummary('missing-id'), (error: any) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
  assert.equal(geminiCalled, false);
});

test('generateAiSummary: propagates an honest error when Gemini is unavailable/fails (no fabricated summary)', async (t) => {
  const { disputeService } = await loadService(t, {
    generateStructured: async () => {
      throw new Error('Gemini provider unavailable');
    },
  });

  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), /Gemini provider unavailable/);
});

test('generateAiSummary: the real validator rejects output missing a required field', async (t) => {
  const { disputeService } = await loadService(t, {
    generateStructured: async (_prompt: string, options: any) => {
      const malformed = validSummaryFixture({ evidenceGaps: undefined });
      assert.equal(options.validate(malformed), false, 'must reject a response missing evidenceGaps');
      throw new Error('INVALID_RESPONSE');
    },
  });

  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), /INVALID_RESPONSE/);
});

test('generateAiSummary: the real validator rejects an oversized array (bounds enforced)', async (t) => {
  const { disputeService } = await loadService(t, {
    generateStructured: async (_prompt: string, options: any) => {
      const tooMany = validSummaryFixture({ suggestedQuestions: Array.from({ length: 20 }, (_, i) => `سؤال ${i}`) });
      assert.equal(options.validate(tooMany), false, 'must reject an array exceeding the max item count');
      throw new Error('INVALID_RESPONSE');
    },
  });

  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), /INVALID_RESPONSE/);
});

test('generateAiSummary: the real validator rejects any forbidden verdict/fault/money field, even if Gemini adds one', async (t) => {
  const { disputeService } = await loadService(t, {
    generateStructured: async (_prompt: string, options: any) => {
      const withVerdict = { ...validSummaryFixture(), winner: 'client', faultPercentage: 80 };
      assert.equal(options.validate(withVerdict), false, 'must reject any response carrying a verdict/fault/money field');
      throw new Error('INVALID_RESPONSE');
    },
  });

  await assert.rejects(() => disputeService.generateAiSummary('dispute-1'), /INVALID_RESPONSE/);
});

test('generateAiSummary: works with no project/stage data at all (only reason/description/evidence)', async (t) => {
  const { disputeService } = await loadService(t, {
    dispute: disputeFixture({ request: null, project: null, evidence: [] }),
    generateStructured: async (prompt: string) => {
      assert.match(prompt, /لا توجد أدلة مرفقة على هذا النزاع/);
      return { data: validSummaryFixture(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  });

  const result = await disputeService.generateAiSummary('dispute-1');
  assert.ok(result.caseSummary);
});

test('generateAiSummary: includes project stage/delivery data in the prompt when present', async (t) => {
  let capturedPrompt = '';
  await (
    await loadService(t, {
      dispute: disputeFixture({
        request: null,
        project: {
          title: 'مشروع تطوير',
          description: 'وصف المشروع',
          contract: {
            stages: [
              {
                stepOrder: 1,
                title: 'المرحلة الأولى',
                description: 'تسليم التصميم الأولي',
                status: 'APPROVED',
                deliveries: [{ note: 'تم تسليم الملفات كاملة', status: 'APPROVED', submittedAt: new Date() }],
              },
            ],
          },
        },
      }),
      generateStructured: async (prompt: string) => {
        capturedPrompt = prompt;
        return { data: validSummaryFixture(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    })
  ).disputeService.generateAiSummary('dispute-1');

  assert.match(capturedPrompt, /المرحلة الأولى/);
  assert.match(capturedPrompt, /تم تسليم الملفات كاملة/);
});
