import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

// Regression coverage for the Explore Requests visibility fix: this task
// explicitly must NOT add a new APPROVED-specialty restriction on proposal
// submission, and must NOT weaken the existing legitimate proposal checks.

const VALID_MILESTONES = [
  { stepOrder: 1, title: 'مرحلة أولى', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 100, amount: 1000 }
];

function baseProposalPayload(overrides: any = {}) {
  return {
    title: 'عرض تجريبي احترافي',
    message: 'وصف تفصيلي لعرضي يوضح خبرتي ومنهجيتي في العمل على هذا المشروع بشكل كامل.',
    advantages: [],
    outputs: '',
    portfolioIds: [],
    totalPrice: 1000,
    deliveryDays: 5,
    milestones: VALID_MILESTONES,
    agreedToTerms: true,
    agreedToEscrow: true,
    ...overrides
  };
}

function createProposalMockPrisma(t: TestContext, opts: { existingProposal?: any; aiEvaluationError?: unknown; evalCalls?: any[]; fitError?: unknown; fitResult?: any; fitCalls?: any[] } = {}) {
  const projectFixture = {
    id: 'project-1',
    clientId: 'client-1',
    title: 'مشروع تجريبي',
    status: 'OPEN',
    budgetMin: 500,
    budgetMax: 1500
  };

  const projectProposalCreateSpy = t.mock.fn(async (args: any) => ({
    id: 'proposal-1',
    ...args.data,
    provider: { id: 'provider-1', firstName: 'مزود', lastName: 'خدمة', providerProfile: null }
  }));

  // Intentionally has NO `providerSpecialty` key at all: if createProposal
  // ever starts consulting ProviderSpecialty (a new approval gate), this
  // mock throws on the missing property and the "no specialty gate" test
  // below fails loudly instead of silently passing.
  const txStub = {
    projectProposal: { create: projectProposalCreateSpy },
    proposal: { create: async () => ({}) },
    clientRequest: { update: async () => ({}) },
    project: { update: async () => ({}) },
    notification: { create: async () => ({}) }
  };

  const prismaMock: any = {
    project: { findUnique: async () => projectFixture },
    clientRequest: { findUnique: async () => null },
    projectProposal: { findUnique: async () => opts.existingProposal ?? null },
    proposal: { findFirst: async () => null },
    $transaction: async (fn: any) => fn(txStub)
  };

  t.mock.module('../utils/prisma.client', { namedExports: { prisma: prismaMock } });
  t.mock.module('./ai-proposal.service', {
    namedExports: {
      aiProposalService: {
        evaluate: opts.aiEvaluationError !== undefined
          ? async () => { throw opts.aiEvaluationError; }
          : async (input: any) => { opts.evalCalls?.push(input); return {
            qualityScore: 80,
            qualityTag: 'جيد',
            summary: 'ملخص التقييم'
          }; }
      }
    }
  });
  t.mock.module('./ai-features/project-fit.service', { namedExports: { projectFitService: {
    analyze: async (...args: any[]) => {
      opts.fitCalls?.push(args);
      if (opts.fitError) throw opts.fitError;
      return opts.fitResult ?? { generationSource: null, insufficientData: true, analysis: null, inputsUsed: [], unavailableFields: [] };
    },
  } } });

  return { prismaMock, projectProposalCreateSpy };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createProposalMockPrisma>[1]) {
  const { projectProposalCreateSpy } = createProposalMockPrisma(t, opts);
  const moduleUrl = `./proposal.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { proposalService } = await import(moduleUrl);
  return { service: proposalService, projectProposalCreateSpy };
}

test('createProposal: a duplicate proposal from the same provider is still rejected (existing restriction remains enforced)', async (t) => {
  const { service } = await loadService(t, { existingProposal: { id: 'existing-proposal' } });

  await assert.rejects(
    () => service.createProposal('project-1', 'provider-1', baseProposalPayload()),
    (err: any) => {
      assert.match(err.message, /عرض مسبق/);
      return true;
    }
  );
});

test('createProposal: milestone percentages not summing to 100% are still rejected (existing validation remains intact)', async (t) => {
  const { service } = await loadService(t);
  const payload = baseProposalPayload({
    milestones: [{ stepOrder: 1, title: 'مرحلة أولى', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 60, amount: 600 }]
  });

  await assert.rejects(
    () => service.createProposal('project-1', 'provider-1', payload),
    (err: any) => {
      assert.match(err.message, /100%/);
      return true;
    }
  );
});

test('createProposal: succeeds for a provider with no ProviderSpecialty record at all — submission is not gated by specialty approval', async (t) => {
  const { service } = await loadService(t);
  const result = await service.createProposal('project-1', 'provider-1', baseProposalPayload());
  assert.equal(result.id, 'proposal-1');
});

// ── Phase 3 fix: F27 — AI evaluation failure must never block a real
// proposal submission (honest fail-open, no fabricated AI fields) ──

test('createProposal: a Gemini/AI evaluation failure still creates the proposal successfully with status SUBMITTED', async (t) => {
  const { service, projectProposalCreateSpy } = await loadService(t, { aiEvaluationError: new Error('AI unavailable') });

  const result = await service.createProposal('project-1', 'provider-1', baseProposalPayload());

  assert.equal(result.id, 'proposal-1');
  assert.equal(projectProposalCreateSpy.mock.callCount(), 1);
  assert.equal(projectProposalCreateSpy.mock.calls[0].arguments[0].data.status, 'SUBMITTED');
});

test('createProposal: on AI evaluation failure, aiMatchScore/aiQualityTag/aiPriceTag/aiFeedback are honestly null — never a fabricated score', async (t) => {
  const { service, projectProposalCreateSpy } = await loadService(t, { aiEvaluationError: new Error('AI unavailable') });

  await service.createProposal('project-1', 'provider-1', baseProposalPayload());

  const data = projectProposalCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.aiMatchScore, null);
  assert.equal(data.aiQualityTag, null);
  assert.equal(data.aiPriceTag, null);
  assert.equal(data.aiFeedback, Prisma.DbNull);
});

test('createProposal: raw provider errors are never propagated to the caller on AI failure — submission still resolves normally', async (t) => {
  const { WaseetAiError, WaseetAiErrorCode } = await import('./ai/waseet-ai/waseet-ai.errors');
  const { service } = await loadService(t, { aiEvaluationError: new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, 'raw provider detail that must never leak') });

  const result = await service.createProposal('project-1', 'provider-1', baseProposalPayload());
  assert.equal(result.id, 'proposal-1');
});

test('createProposal: a successful AI evaluation still populates the real aiMatchScore/aiQualityTag/aiPriceTag/aiFeedback exactly as before (unchanged happy path)', async (t) => {
  const { service, projectProposalCreateSpy } = await loadService(t);

  await service.createProposal('project-1', 'provider-1', baseProposalPayload());

  const data = projectProposalCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.aiQualityTag, 'جيد');
  assert.equal(data.aiPriceTag, null, 'no price tag: the WaseetAI priceAudit is ungrounded and dropped');
  assert.equal(typeof data.aiMatchScore, 'number');
  assert.ok(data.aiFeedback && typeof data.aiFeedback === 'object');
});

test('createProposal: evaluates the real proposal and preserves pure quality independently of the budget midpoint', async (t) => {
  const evalCalls: any[] = [];
  const { service, projectProposalCreateSpy } = await loadService(t, { evalCalls });
  await service.createProposal('project-1', 'provider-1', baseProposalPayload());
  assert.deepEqual(evalCalls, [{
    projectId: 'project-1', title: 'عرض تجريبي احترافي',
    message: 'وصف تفصيلي لعرضي يوضح خبرتي ومنهجيتي في العمل على هذا المشروع بشكل كامل.',
    totalPrice: 1000, deliveryDays: 5, milestones: VALID_MILESTONES
  }]);
  const data = projectProposalCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.aiMatchScore, 80);
  assert.equal(data.aiQualityTag, 'جيد');
  assert.equal(data.aiPriceTag, null);
  assert.equal(data.aiFeedback.source, 'WASEET_AI');
  assert.equal(data.aiFeedback.summary, 'ملخص التقييم');
  assert.equal(data.aiFeedback.qualityScore, 80);
  assert.equal(data.aiFeedback.budgetSuitability.status, 'WITHIN_RANGE');
  assert.equal(data.aiFeedback.deadlineSuitability.status, 'UNKNOWN');
  await service.createProposal('project-1', 'provider-2', baseProposalPayload({ totalPrice: 600 }));
  assert.equal(projectProposalCreateSpy.mock.calls[1].arguments[0].data.aiMatchScore, 80, 'a cheaper appropriate offer must not lose text-quality points');
});

const FIT_RESULT = { generationSource: 'LLM', insufficientData: false, analysis: {
  overallFit: 'HIGH', summary: 'مهارات المقدم تناسب متطلبات الطلب.',
  matchPoints: [{ text: 'React في المتطلبات والملف.', basedOn: ['project.requiredSkills', 'provider.skills'] }], gaps: [],
}, inputsUsed: ['project.requiredSkills', 'provider.skills'], unavailableFields: [] };

test('createProposal: the actual provider, project and submitted comment/plan are compared and evidence stored without changing submission status', async (t) => {
  const fitCalls: any[] = [];
  const { service, projectProposalCreateSpy } = await loadService(t, { fitCalls, fitResult: FIT_RESULT });
  const payload = baseProposalPayload();
  await service.createProposal('project-1', 'provider-1', payload);
  assert.deepEqual(fitCalls, [['provider-1', 'project-1', {
    title: payload.title, message: payload.message, outputs: '', advantages: [],
    milestones: VALID_MILESTONES.map(({ title, description }) => ({ title, description })),
  }]]);
  const data = projectProposalCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.aiFeedback.providerFit.source, 'LLM');
  assert.deepEqual(data.aiFeedback.providerFit.matchPoints, FIT_RESULT.analysis.matchPoints);
  assert.equal(data.status, 'SUBMITTED');
});

test('createProposal: fit failure preserves proposal quality and does not block submission', async (t) => {
  const qualityOnly = await loadService(t, { fitError: new Error('fit unavailable') });
  await qualityOnly.service.createProposal('project-1', 'provider-1', baseProposalPayload());
  const qualityData = qualityOnly.projectProposalCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(qualityData.aiMatchScore, 80);
  assert.equal(qualityData.aiFeedback.providerFit, undefined);
  assert.equal(qualityData.status, 'SUBMITTED');
});

test('createProposal: quality failure preserves grounded fit without inventing the missing score', async (t) => {
  const fitOnly = await loadService(t, { aiEvaluationError: new Error('quality unavailable'), fitResult: FIT_RESULT });
  await fitOnly.service.createProposal('project-1', 'provider-1', baseProposalPayload());
  const fitData = fitOnly.projectProposalCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(fitData.aiMatchScore, null);
  assert.equal(fitData.aiQualityTag, null);
  assert.equal(fitData.aiFeedback.qualityScore, undefined);
  assert.equal(fitData.aiFeedback.providerFit.overallFit, 'HIGH');
  assert.equal(fitData.status, 'SUBMITTED');
});

test('proposal.service.ts (WaseetAI-linked) has no internal LlmClient dependency', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./proposal.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gemini\.client|geminiClient|generateStructured|generateStream/);
});
