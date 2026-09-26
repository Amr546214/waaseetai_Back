import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 8 — advisory-only Gemini project health analysis
// (getProjectHealthAnalysis). This single capability represents Contract
// Monitoring, Project Health, Predictive Delay Risk, and Predictive Dispute
// Risk. `prisma` (via ../config/db) and `geminiClient` are both mocked; no
// real DB/network call ever happens. These tests prove the feature is
// read-only (no update/create/delete write path is ever exercised), that it
// never lets a binding decision field through, and that it never fabricates
// a result when Gemini is unavailable.

function contractFixture(overrides: Partial<any> = {}) {
  return {
    id: 'contract-1',
    clientId: 'client-1',
    providerId: 'provider-1',
    projectId: 'project-1',
    durationDays: 30,
    signedAt: new Date(Date.now() - 10 * 86400000),
    createdAt: new Date(Date.now() - 10 * 86400000),
    project: { title: 'تصميم متجر إلكتروني' },
    amendments: [],
    ...overrides,
  };
}

function stageFixture(overrides: Partial<any> = {}) {
  return {
    title: 'المرحلة الأولى: التصميم',
    days: 10,
    startedAt: new Date(Date.now() - 5 * 86400000),
    status: 'IN_PROGRESS',
    deliveries: [],
    ...overrides,
  };
}

function validHealthFixture(overrides: Partial<any> = {}) {
  return {
    riskLevelKey: 'LOW',
    healthRating: 'المشروع يسير ضمن الجدول الزمني المتوقع.',
    confidence: 72,
    bullets: ['المرحلة الحالية ضمن مدتها المخطط لها.', 'لا توجد طلبات تعديل متكررة حتى الآن.'],
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: {
  contract?: any;
  stages?: any[];
  disputes?: any[];
  generateStructured?: (prompt: string, options: any) => Promise<any>;
} = {}) {
  const denyWrite = () => { throw new Error('Project health analysis attempted a DB write'); };
  const contractFindFirstSpy = t.mock.fn(async () => (opts.contract === undefined ? contractFixture() : opts.contract));
  const stagesFindManySpy = t.mock.fn(async () => (opts.stages === undefined ? [stageFixture()] : opts.stages));
  const disputeFindManySpy = t.mock.fn(async () => opts.disputes ?? []);

  const prismaMock: any = {
    contract: { findFirst: contractFindFirstSpy, update: denyWrite, updateMany: denyWrite, create: denyWrite },
    projectStage: { findMany: stagesFindManySpy, findFirst: denyWrite, update: denyWrite, updateMany: denyWrite, create: denyWrite },
    dispute: { findMany: disputeFindManySpy, update: denyWrite, updateMany: denyWrite, create: denyWrite },
    stageDelivery: { update: denyWrite, updateMany: denyWrite, create: denyWrite },
    project: { update: denyWrite, updateMany: denyWrite },
    escrow: { update: denyWrite, updateMany: denyWrite },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  // Same isolation as delivery-ai-review.service.test.ts — avoid pulling in
  // real socket/mail transports (or openai-tts.client.ts's module-load-time
  // OpenAI() construction) via project-progress.service.ts's other imports.
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); }),
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.projectProgressService, contractFindFirstSpy, stagesFindManySpy, disputeFindManySpy };
}

test('getProjectHealthAnalysis: authenticated CLIENT owner gets a validated analysis, zero writes', async t => {
  const health = validHealthFixture();
  const { service } = await loadService(t, {
    generateStructured: async (prompt: string, options: any) => {
      assert.equal(options.validate(health), true, 'the real validator must accept well-formed advisory output');
      assert.match(prompt, /تصميم متجر إلكتروني/, 'the real project title must reach the prompt');
      return { data: health };
    },
  });
  const result = await service.getProjectHealthAnalysis('client-1', 'contract-1');
  assert.equal(result.healthRating, health.healthRating);
  assert.equal(result.confidence, health.confidence);
  assert.equal(result.riskLevel, 'منخفضة');
  assert.equal(result.riskLevelKey, 'LOW');
  assert.deepEqual(result.bullets, health.bullets);
  assert.equal(result.matchPercentage, null);
  assert.equal(typeof result.earlyDays, 'number');
});

test('getProjectHealthAnalysis: authenticated PROVIDER owner gets the same analysis shape, zero writes', async t => {
  const health = validHealthFixture();
  const { service } = await loadService(t, {
    generateStructured: async () => ({ data: health }),
  });
  const result = await service.getProjectHealthAnalysis('provider-1', 'contract-1');
  assert.equal(result.healthRating, health.healthRating);
});

test('getProjectHealthAnalysis: an unrelated authenticated user is forbidden (403), no Gemini call', async t => {
  let called = false;
  const { service } = await loadService(t, {
    generateStructured: async () => { called = true; return { data: validHealthFixture() }; },
  });
  await assert.rejects(
    service.getProjectHealthAnalysis('stranger-1', 'contract-1'),
    (e: any) => e.statusCode === 403
  );
  assert.equal(called, false);
});

test('getProjectHealthAnalysis: contract not found gives a distinct 404, no Gemini call', async t => {
  let called = false;
  const { service } = await loadService(t, {
    contract: null,
    generateStructured: async () => { called = true; return { data: validHealthFixture() }; },
  });
  await assert.rejects(
    service.getProjectHealthAnalysis('client-1', 'missing-contract'),
    (e: any) => e.statusCode === 404
  );
  assert.equal(called, false);
});

test('getProjectHealthAnalysis: no stage has started and no delivery exists yet -> honest "not enough data", no Gemini call', async t => {
  let called = false;
  const { service } = await loadService(t, {
    stages: [stageFixture({ status: 'PENDING', startedAt: null, deliveries: [] })],
    generateStructured: async () => { called = true; return { data: validHealthFixture() }; },
  });
  const result = await service.getProjectHealthAnalysis('client-1', 'contract-1');
  assert.equal(called, false, 'Gemini must never be called when there is genuinely nothing to analyze yet');
  assert.deepEqual(result, {
    confidence: 0, riskLevel: 'غير محسوبة', riskLevelKey: 'UNKNOWN',
    healthRating: 'بانتظار بيانات كافية', bullets: [], earlyDays: null, matchPercentage: null
  });
});

test('getProjectHealthAnalysis: real context construction includes elapsed time, stage counts, revision count, and dispute count', async t => {
  const health = validHealthFixture();
  const { service } = await loadService(t, {
    stages: [
      stageFixture({ status: 'APPROVED', deliveries: [{ status: 'APPROVED' }] }),
      stageFixture({ status: 'IN_PROGRESS', deliveries: [{ status: 'REVISION_REQUESTED' }, { status: 'SUBMITTED' }] }),
    ],
    disputes: [{ status: 'OPEN' }, { status: 'RESOLVED' }],
    generateStructured: async (prompt: string) => {
      assert.match(prompt, /المدة الإجمالية المخطط لها: 30 يوم/);
      assert.match(prompt, /عدد المراحل الكلي: 2/);
      assert.match(prompt, /عدد المراحل المكتملة والمعتمدة: 1/);
      assert.match(prompt, /عدد طلبات التعديل.*: 1/);
      assert.match(prompt, /عدد النزاعات المفتوحة أو قيد المراجعة.*: 1/);
      return { data: health };
    },
  });
  await service.getProjectHealthAnalysis('client-1', 'contract-1');
});

test('getProjectHealthAnalysis: no client/provider names or emails are sent to Gemini', async t => {
  const health = validHealthFixture();
  const { service } = await loadService(t, {
    generateStructured: async (prompt: string) => {
      assert.doesNotMatch(prompt, /@/, 'no email address should ever appear in the prompt');
      return { data: health };
    },
  });
  await service.getProjectHealthAnalysis('client-1', 'contract-1');
});

test('getProjectHealthAnalysis: Gemini unavailable surfaces an honest error, no fabricated result', async t => {
  const { service } = await loadService(t, {
    generateStructured: async () => { throw Object.assign(new Error('Gemini unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); },
  });
  await assert.rejects(service.getProjectHealthAnalysis('client-1', 'contract-1'));
});

for (const [label, malformed] of Object.entries({
  'null': null,
  'array': [],
  'missing bullets': { riskLevelKey: 'LOW', healthRating: 'ok', confidence: 50 },
  'invalid riskLevelKey': { ...validHealthFixture(), riskLevelKey: 'CATASTROPHIC' },
  'confidence out of range': { ...validHealthFixture(), confidence: 150 },
  'non-array bullets': { ...validHealthFixture(), bullets: 'not-an-array' },
  'oversized healthRating': { ...validHealthFixture(), healthRating: 'أ'.repeat(401) },
  'too many bullets': { ...validHealthFixture(), bullets: Array.from({ length: 6 }, (_, i) => `bullet ${i}`) },
  'oversized bullet': { ...validHealthFixture(), bullets: ['أ'.repeat(241)] },
  'extra unexpected key': { ...validHealthFixture(), extraNote: 'not allowed' },
})) {
  test(`getProjectHealthAnalysis: rejects malformed structured output (${label})`, async t => {
    const { service } = await loadService(t, {
      generateStructured: async (_prompt: string, options: any) => {
        if (!options.validate(malformed)) throw new Error('INVALID_RESPONSE');
        return { data: malformed };
      },
    });
    await assert.rejects(service.getProjectHealthAnalysis('client-1', 'contract-1'));
  });
}

for (const forbiddenKey of [
  'verdict', 'approved', 'releaseFunds', 'refund', 'faultPercentage', 'winner',
  'terminateContract', 'suspendAccount', 'resolveDispute', 'contractStatus', 'escrowStatus'
]) {
  test(`getProjectHealthAnalysis: rejects a forbidden decision field ("${forbiddenKey}") even alongside valid fields`, async t => {
    const withForbiddenKey = { ...validHealthFixture(), [forbiddenKey]: true };
    const { service } = await loadService(t, {
      generateStructured: async (_prompt: string, options: any) => {
        assert.equal(options.validate(withForbiddenKey), false, `validator must reject a response containing "${forbiddenKey}"`);
        throw new Error('INVALID_RESPONSE');
      },
    });
    await assert.rejects(service.getProjectHealthAnalysis('client-1', 'contract-1'));
  });
}

test('getProjectHealthAnalysis: Gemini schema never exposes a field for earlyDays/matchPercentage — those are always application-computed', async t => {
  const health = validHealthFixture();
  const { service } = await loadService(t, {
    generateStructured: async (_prompt: string, options: any) => {
      const keys = Object.keys(options.responseSchema.properties);
      assert.equal(keys.includes('earlyDays'), false);
      assert.equal(keys.includes('matchPercentage'), false);
      return { data: health };
    },
  });
  const result = await service.getProjectHealthAnalysis('client-1', 'contract-1');
  assert.equal(result.matchPercentage, null);
});
