import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 6 — real public client profile. Replaces the
// frontend's previous buildMockClientProfile() (hardcoded aiTrust
// 94/97/89 + a fabricated "97% payment rate" recommendation). These tests
// prove every returned field is a genuine deterministic aggregate — no
// Gemini call exists anywhere in this file — and that no sensitive field
// (national ID, DOB, address, bank/IBAN, KYC documents, email, phone) is
// ever read or returned.

function userFixture(overrides: Partial<any> = {}) {
  return {
    firstName: 'خالد',
    lastName: 'العتيبي',
    avatarUrl: 'https://cdn.example.com/avatar.png',
    createdAt: new Date('2023-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

function clientProfileFixture(overrides: Partial<any> = {}) {
  return {
    firstName: null,
    lastName: null,
    avatarUrl: null,
    bio: 'أبحث دائماً عن جودة عالية والتزام بالمواعيد.',
    city: 'الرياض',
    country: 'السعودية',
    isNafathVerified: true,
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: {
  user?: any;
  clientProfile?: any;
  completedProjects?: number;
  activeProjects?: number;
  totalContracts?: number;
  reviewsCount?: number;
  avgRating?: number | null;
  recentReviews?: any[];
} = {}) {
  const denyWrite = () => { throw new Error('Client public profile attempted a DB write'); };
  const projectCountSpy = t.mock.fn(async (args: any) => {
    const status = args.where.status;
    if (status === 'COMPLETED') return opts.completedProjects ?? 3;
    return opts.activeProjects ?? 1;
  });
  const reviewFindManyArgs: any[] = [];
  const prismaMock: any = {
    user: { findUnique: async () => (opts.user === undefined ? userFixture() : opts.user), update: denyWrite, create: denyWrite },
    clientProfile: { findUnique: async () => (opts.clientProfile === undefined ? clientProfileFixture() : opts.clientProfile), update: denyWrite, upsert: denyWrite, create: denyWrite },
    project: { count: projectCountSpy },
    contract: { count: async () => opts.totalContracts ?? 5 },
    review: {
      count: async () => opts.reviewsCount ?? 2,
      aggregate: async () => ({ _avg: { rating: opts.avgRating === undefined ? 4.5 : opts.avgRating } }),
      findMany: async (args: any) => { reviewFindManyArgs.push(args); return opts.recentReviews ?? [
        { rating: 5, comment: 'التزام ممتاز بالمواعيد ودفع فوري.', createdAt: new Date('2024-02-01T00:00:00.000Z'), provider: { firstName: 'سارة', lastName: 'الحربي' } },
        { rating: 4, comment: null, createdAt: new Date('2024-01-01T00:00:00.000Z'), provider: { firstName: 'فيصل', lastName: 'السلمي' } },
      ]; },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./client-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.clientProfileService, projectCountSpy, reviewFindManyArgs };
}

test('getPublicProfile: returns real deterministic facts for an existing client, zero writes', async t => {
  const { service } = await loadService(t);
  const result = await service.getPublicProfile('client-1');
  assert.equal(result.name, 'خالد العتيبي');
  assert.equal(result.bio, 'أبحث دائماً عن جودة عالية والتزام بالمواعيد.');
  assert.equal(result.city, 'الرياض');
  assert.equal(result.isVerified, true);
  assert.deepEqual(result.stats, {
    completedProjects: 3,
    activeProjects: 1,
    totalContracts: 5,
    providerReviewsCount: 2,
    providerRatingAverage: 4.5,
  });
  assert.equal(result.reviewsFromProviders.length, 2);
  assert.equal(result.reviewsFromProviders[0].providerName, 'سارة الحربي');
});

test('getPublicProfile: only reads reviews where reviewerRole is PROVIDER (providers rating this client)', async t => {
  const { reviewFindManyArgs, service } = await loadService(t);
  await service.getPublicProfile('client-1');
  for (const args of reviewFindManyArgs) {
    assert.equal(args.where.reviewerRole, 'PROVIDER');
    assert.equal(args.where.clientId, 'client-1');
  }
});

test('getPublicProfile: honest null (not 0) rating average when there is no review history yet', async t => {
  const { service } = await loadService(t, { reviewsCount: 0, avgRating: null, recentReviews: [] });
  const result = await service.getPublicProfile('client-1');
  assert.equal(result.stats.providerRatingAverage, null);
  assert.equal(result.stats.providerReviewsCount, 0);
  assert.deepEqual(result.reviewsFromProviders, []);
});

test('getPublicProfile: no fabricated trust score, payment rate, or commitment percentage field exists anywhere in the response shape', async t => {
  const { service } = await loadService(t);
  const result: any = await service.getPublicProfile('client-1');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /aiTrust|trustLabel|commitmentRate|aiRecommendation|paymentRate|commitmentPercentage/i);
  assert.equal('aiTrust' in result, false);
  assert.equal('aiRecommendation' in result, false);
});

test('getPublicProfile: never selects or returns sensitive fields (national ID, DOB, address, bank, IBAN, KYC documents)', async t => {
  const { service } = await loadService(t);
  const result: any = await service.getPublicProfile('client-1');
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['idnumber', 'dob', 'address', 'iban', 'bankname', 'accountholder', 'frontidurl', 'backidurl', 'supportingdocs', 'email', 'phone']) {
    assert.equal(serialized.includes(forbidden), false, `response must never include "${forbidden}"`);
  }
});

test('getPublicProfile: a user with no ClientProfile row (e.g. a provider id, or a client who never completed setup) gives a 404, not a leaked profile', async t => {
  const { service } = await loadService(t, { clientProfile: null });
  await assert.rejects(service.getPublicProfile('not-a-client'), (e: any) => e.statusCode === 404);
});

test('getPublicProfile: a genuinely missing user id gives a 404', async t => {
  const { service } = await loadService(t, { user: null, clientProfile: null });
  await assert.rejects(service.getPublicProfile('missing'), (e: any) => e.statusCode === 404);
});

test('getPublicProfile: role-specific ClientProfile display fields take precedence over legacy User fields', async t => {
  const { service } = await loadService(t, { clientProfile: clientProfileFixture({ firstName: 'وليد', lastName: 'الشمري', avatarUrl: 'https://cdn.example.com/client-own.png' }) });
  const result = await service.getPublicProfile('client-1');
  assert.equal(result.name, 'وليد الشمري');
  assert.equal(result.avatarUrl, 'https://cdn.example.com/client-own.png');
});

test('getPublicProfile: falls back to the legacy User name/avatar only when ClientProfile has none set', async t => {
  const { service } = await loadService(t);
  const result = await service.getPublicProfile('client-1');
  assert.equal(result.name, 'خالد العتيبي');
  assert.equal(result.avatarUrl, 'https://cdn.example.com/avatar.png');
});
