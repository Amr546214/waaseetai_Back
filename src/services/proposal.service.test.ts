import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

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

function createProposalMockPrisma(t: TestContext, opts: { existingProposal?: any } = {}) {
  const projectFixture = {
    id: 'project-1',
    clientId: 'client-1',
    title: 'مشروع تجريبي',
    status: 'OPEN',
    budgetMin: 500,
    budgetMax: 1500
  };

  // Intentionally has NO `providerSpecialty` key at all: if createProposal
  // ever starts consulting ProviderSpecialty (a new approval gate), this
  // mock throws on the missing property and the "no specialty gate" test
  // below fails loudly instead of silently passing.
  const txStub = {
    projectProposal: {
      create: async (args: any) => ({
        id: 'proposal-1',
        ...args.data,
        provider: { id: 'provider-1', firstName: 'مزود', lastName: 'خدمة', providerProfile: null }
      })
    },
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
        evaluateAndSuggestProposal: async () => ({
          qualityScore: 80,
          qualityTag: 'جيد',
          priceAudit: { priceTag: 'مناسب' }
        })
      }
    }
  });

  return prismaMock;
}

async function loadService(t: TestContext, opts?: Parameters<typeof createProposalMockPrisma>[1]) {
  createProposalMockPrisma(t, opts);
  const moduleUrl = `./proposal.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { proposalService } = await import(moduleUrl);
  return proposalService;
}

test('createProposal: a duplicate proposal from the same provider is still rejected (existing restriction remains enforced)', async (t) => {
  const service = await loadService(t, { existingProposal: { id: 'existing-proposal' } });

  await assert.rejects(
    () => service.createProposal('project-1', 'provider-1', baseProposalPayload()),
    (err: any) => {
      assert.match(err.message, /عرض مسبق/);
      return true;
    }
  );
});

test('createProposal: milestone percentages not summing to 100% are still rejected (existing validation remains intact)', async (t) => {
  const service = await loadService(t);
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
  const service = await loadService(t);
  const result = await service.createProposal('project-1', 'provider-1', baseProposalPayload());
  assert.equal(result.id, 'proposal-1');
});
