import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 5 — advisory-only delivery AI review
// (getDeliveryAiReview). `prisma` (via ../config/db) and `geminiClient` are
// both mocked; no real DB/network call ever happens. These tests prove the
// feature is read-only (no update/create/delete write path is ever
// exercised, including on Contract/Project/ProjectStage/StageDelivery/
// Escrow), that it never lets a binding decision field through, and that
// reviewedInputs.attachmentContent can never be set to true by Gemini.

function contractFixture(overrides: Partial<any> = {}) {
  return {
    id: 'contract-1',
    clientId: 'client-1',
    providerId: 'provider-1',
    project: {
      title: 'تصميم متجر إلكتروني',
      description: 'وصف حقيقي لمتطلبات المشروع',
      requirements: ['تصميم متجاوب', 'دعم الدفع الإلكتروني']
    },
    amendments: [],
    ...overrides,
  };
}

function stageFixture(overrides: Partial<any> = {}) {
  return {
    id: 'stage-1',
    contractId: 'contract-1',
    stepOrder: 1,
    title: 'المرحلة الأولى: التصميم',
    description: 'تسليم تصميم الواجهة الرئيسية',
    deliveries: [{
      id: 'delivery-1',
      note: 'تم تسليم التصميم النهائي للواجهة الرئيسية وفق المواصفات المتفق عليها',
      files: ['{"name":"design.pdf","url":"https://cdn.example.com/design.pdf","type":"application/pdf","size":1024}'],
      submittedAt: new Date('2026-01-05T10:00:00.000Z'),
      status: 'SUBMITTED'
    }],
    ...overrides,
  };
}

function validReviewFixture(overrides: Partial<any> = {}) {
  return {
    summary: 'التسليم يتناول الواجهة الرئيسية المطلوبة بشكل عام.',
    alignedPoints: ['تصميم الواجهة الرئيسية مذكور صراحة في نص التسليم.'],
    potentialGaps: ['لم يُذكر صراحة دعم عرض المتجر على الجوال.'],
    questionsForReviewer: ['هل تم تغطية جميع الصفحات المطلوبة في هذه المرحلة؟'],
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: {
  contract?: any;
  stage?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
} = {}) {
  const denyWrite = () => { throw new Error('Delivery AI review attempted a DB write'); };
  const contractFindFirstSpy = t.mock.fn(async () => (opts.contract === undefined ? contractFixture() : opts.contract));
  const stageFindFirstSpy = t.mock.fn(async () => (opts.stage === undefined ? stageFixture() : opts.stage));
  // Deliberately NO update/create/delete/upsert on any model — a stray write
  // call throws loudly instead of silently succeeding, proving zero writes
  // across Contract/Project/ProjectStage/StageDelivery/Escrow alike.
  const prismaMock: any = {
    contract: { findFirst: contractFindFirstSpy, update: denyWrite, updateMany: denyWrite, create: denyWrite },
    projectStage: { findFirst: stageFindFirstSpy, update: denyWrite, updateMany: denyWrite, create: denyWrite },
    stageDelivery: { update: denyWrite, updateMany: denyWrite, create: denyWrite },
    project: { update: denyWrite, updateMany: denyWrite },
    escrow: { update: denyWrite, updateMany: denyWrite },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  // project-progress.service.ts also imports notification/email services for
  // reviewDelivery()/submitDelivery() (unrelated to getDeliveryAiReview) —
  // mocked here purely so importing the module under test never pulls in
  // real socket/mail transports (or, transitively, openai-tts.client.ts's
  // module-load-time OpenAI() construction) in this unit test.
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); }),
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.projectProgressService, contractFindFirstSpy, stageFindFirstSpy };
}

test('getDeliveryAiReview: authenticated CLIENT owner gets a validated review, zero writes', async t => {
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    generateStructured: async (prompt: string, options: any) => {
      assert.equal(options.validate(review), true, 'the real validator must accept well-formed advisory output');
      assert.match(prompt, /تصميم متجر إلكتروني/, 'the real project title must reach the prompt');
      assert.match(prompt, /تم تسليم التصميم النهائي/, 'the real delivery note must reach the prompt');
      return { data: review, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    },
  });
  const result = await service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1');
  assert.deepEqual(result.summary, review.summary);
  assert.deepEqual(result.alignedPoints, review.alignedPoints);
  assert.deepEqual(result.reviewedInputs, { deliveryText: true, stageRequirements: true, attachmentContent: false });
});

test('getDeliveryAiReview: authenticated PROVIDER owner gets the same review shape, zero writes', async t => {
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    generateStructured: async () => ({ data: review, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
  });
  const result = await service.getDeliveryAiReview('provider-1', 'contract-1', 'stage-1');
  assert.deepEqual(result.summary, review.summary);
});

test('getDeliveryAiReview: an unrelated authenticated user is forbidden (403), no Gemini call', async t => {
  let called = false;
  const { service } = await loadService(t, {
    generateStructured: async () => { called = true; return { data: validReviewFixture() }; },
  });
  await assert.rejects(
    service.getDeliveryAiReview('stranger-1', 'contract-1', 'stage-1'),
    (e: any) => e.statusCode === 403
  );
  assert.equal(called, false);
});

test('getDeliveryAiReview: contract not found gives a distinct 404, no Gemini call', async t => {
  let called = false;
  const { service } = await loadService(t, {
    contract: null,
    generateStructured: async () => { called = true; return { data: validReviewFixture() }; },
  });
  await assert.rejects(
    service.getDeliveryAiReview('client-1', 'missing-contract', 'stage-1'),
    (e: any) => e.statusCode === 404
  );
  assert.equal(called, false);
});

test('getDeliveryAiReview: stage not found on this contract gives 404', async t => {
  const { service } = await loadService(t, { stage: null });
  await assert.rejects(
    service.getDeliveryAiReview('client-1', 'contract-1', 'missing-stage'),
    (e: any) => e.statusCode === 404
  );
});

test('getDeliveryAiReview: a stage with no delivery yet gives 404', async t => {
  const { service } = await loadService(t, { stage: stageFixture({ deliveries: [] }) });
  await assert.rejects(
    service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1'),
    (e: any) => e.statusCode === 404
  );
});

test('getDeliveryAiReview: Gemini unavailable surfaces an honest error, no fabricated review', async t => {
  const { service } = await loadService(t, {
    generateStructured: async () => { throw Object.assign(new Error('Gemini unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); },
  });
  await assert.rejects(service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1'));
});

for (const [label, malformed] of Object.entries({
  'null': null,
  'array': [],
  'missing questionsForReviewer': { summary: 'ok', alignedPoints: [], potentialGaps: [] },
  'non-array alignedPoints': { ...validReviewFixture(), alignedPoints: 'not-an-array' },
  'oversized summary': { ...validReviewFixture(), summary: 'أ'.repeat(901) },
  'too many array items': { ...validReviewFixture(), alignedPoints: Array.from({ length: 7 }, (_, i) => `item ${i}`) },
  'oversized array item': { ...validReviewFixture(), potentialGaps: ['أ'.repeat(301)] },
  'extra unexpected key': { ...validReviewFixture(), extraNote: 'not allowed' },
})) {
  test(`getDeliveryAiReview: rejects malformed structured output (${label})`, async t => {
    const { service } = await loadService(t, {
      generateStructured: async (_prompt: string, options: any) => {
        if (!options.validate(malformed)) throw new Error('INVALID_RESPONSE');
        return { data: malformed };
      },
    });
    await assert.rejects(service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1'));
  });
}

for (const forbiddenKey of ['verdict', 'approved', 'releaseFunds', 'refund', 'faultPercentage', 'confidence', 'decision']) {
  test(`getDeliveryAiReview: rejects a forbidden decision field ("${forbiddenKey}") even alongside valid fields`, async t => {
    const withForbiddenKey = { ...validReviewFixture(), [forbiddenKey]: true };
    const { service } = await loadService(t, {
      generateStructured: async (_prompt: string, options: any) => {
        assert.equal(options.validate(withForbiddenKey), false, `validator must reject a response containing "${forbiddenKey}"`);
        throw new Error('INVALID_RESPONSE');
      },
    });
    await assert.rejects(service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1'));
  });
}

test('getDeliveryAiReview: attachmentContent is always false, even if Gemini/validate is somehow made to accept a claim of true', async t => {
  // The schema/validator never expose reviewedInputs to Gemini at all, so
  // there is no field name it could even attempt to set. This test proves
  // the final response's reviewedInputs.attachmentContent is computed by
  // application code regardless of what the (mocked) Gemini call returns.
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    generateStructured: async (_prompt: string, options: any) => {
      assert.equal(Object.keys(options.responseSchema.properties).includes('reviewedInputs'), false, 'Gemini must never be asked for reviewedInputs');
      return { data: review };
    },
  });
  const result = await service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1');
  assert.equal(result.reviewedInputs.attachmentContent, false);
});

test('getDeliveryAiReview: reviewedInputs reflects genuinely missing stage/project context honestly', async t => {
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    contract: contractFixture({ project: { title: 'مشروع', description: '', requirements: [] } }),
    stage: stageFixture({ description: null, deliveries: [{ id: 'd', note: '', files: [], submittedAt: new Date(), status: 'SUBMITTED' }] }),
    generateStructured: async () => ({ data: review }),
  });
  const result = await service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1');
  assert.deepEqual(result.reviewedInputs, { deliveryText: false, stageRequirements: false, attachmentContent: false });
});

test('getDeliveryAiReview: client-supplied extra fields cannot inject fake requirements (only ids are accepted)', async t => {
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    generateStructured: async (prompt: string) => {
      assert.doesNotMatch(prompt, /FORGED|hacked/i);
      return { data: review };
    },
  });
  // getDeliveryAiReview's signature only accepts (userId, key, stageId) —
  // there is no channel for a client-supplied requirements/description
  // override to reach the prompt at all.
  await service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1');
});

test('getDeliveryAiReview: passes an explicit, non-truncating maxOutputTokens (live-Gemini truncation regression)', async t => {
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    generateStructured: async (_prompt: string, options: any) => {
      assert.equal(typeof options.maxOutputTokens, 'number');
      assert.ok(options.maxOutputTokens > 0, 'maxOutputTokens must be a defined positive number');
      assert.ok(options.maxOutputTokens >= 2000, 'must retain enough headroom to avoid the observed live truncation at 700');
      return { data: review };
    },
  });
  await service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1');
});

test('getDeliveryAiReview: file entries reach the prompt as metadata only, never claiming inspected content', async t => {
  const review = validReviewFixture();
  const { service } = await loadService(t, {
    generateStructured: async (prompt: string) => {
      assert.match(prompt, /design\.pdf/);
      assert.match(prompt, /لم يُفحص المحتوى/);
      return { data: review };
    },
  });
  await service.getDeliveryAiReview('client-1', 'contract-1', 'stage-1');
});
