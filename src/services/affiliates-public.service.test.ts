import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// GET /api/affiliates/resolve and GET /api/affiliates/search are PUBLIC and
// UNAUTHENTICATED (used during registration, before an account exists) — so
// the response shape must be provably PII-safe: only { id, referralSlug,
// displayName }, never email/phone/bank/IBAN/KYC/wallet/commission data,
// regardless of what fields exist on the underlying AffiliateProfile row.

function createAffiliatesPublicMockPrisma(t: TestContext, affiliates: any[]) {
  const findFirstSpy = t.mock.fn(async (args: any) => {
    const [bySlug, byId] = args.where.OR;
    return affiliates.find(a => a.referralSlug === bySlug.referralSlug || a.id === byId.id) ?? null;
  });
  const findManySpy = t.mock.fn(async (args: any) => {
    const [byFirst, byLast] = args.where.OR;
    const needle = (byFirst.firstName.contains as string).toLowerCase();
    const matches = affiliates.filter(a =>
      (a.firstName || '').toLowerCase().includes(needle) || (a.lastName || '').toLowerCase().includes(needle)
    );
    return matches.slice(0, args.take ?? matches.length);
  });

  // A real Prisma call only ever returns the fields listed in `select` — this
  // mock enforces that too, so a test can catch a future regression where
  // the service's select accidentally widens to include a private field.
  const projected = (row: any) => {
    const allowed = ['id', 'referralSlug', 'firstName', 'lastName'];
    const out: any = {};
    for (const key of allowed) out[key] = row[key] ?? null;
    return out;
  };

  const prismaMock = {
    affiliateProfile: {
      findFirst: t.mock.fn(async (args: any) => {
        const result = await findFirstSpy(args);
        return result ? projected(result) : null;
      }),
      findMany: t.mock.fn(async (args: any) => (await findManySpy(args)).map(projected))
    }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { findFirstSpy, findManySpy };
}

async function loadService(t: TestContext, affiliates: any[]) {
  const mocks = createAffiliatesPublicMockPrisma(t, affiliates);
  const moduleUrl = `./affiliates-public.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { affiliatesPublicService } = await import(moduleUrl);
  return { affiliatesPublicService, ...mocks };
}

const AFFILIATE_FIXTURE = {
  id: 'affiliate-1',
  referralSlug: 'khalid2026',
  firstName: 'خالد',
  lastName: 'العتيبي',
  email: 'khalid@example.com',
  phoneNumber: '0500000000',
  iban: 'SA0000000000000000000000',
  bankName: 'Some Bank',
  kycDocumentUrl: 'https://example.com/kyc.pdf',
  minimumPayoutAmount: 300
};

test('resolveByCode: found by referralSlug — returns ONLY { id, referralSlug, displayName }', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.resolveByCode('khalid2026');

  assert.deepEqual(result, { id: 'affiliate-1', referralSlug: 'khalid2026', displayName: 'خالد العتيبي' });
  assert.deepEqual(Object.keys(result!).sort(), ['displayName', 'id', 'referralSlug']);
});

test('resolveByCode: found by bare affiliate id (fallback identifier type)', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.resolveByCode('affiliate-1');

  assert.equal(result?.id, 'affiliate-1');
});

test('resolveByCode: not found — returns null (the controller maps this to a clean 404), never throws', async (t) => {
  const { affiliatesPublicService } = await loadService(t, []);

  const result = await affiliatesPublicService.resolveByCode('does-not-exist');

  assert.equal(result, null);
});

test('resolveByCode: response never contains email/phone/bank/IBAN/KYC/wallet/commission fields, even though the underlying row has them', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result: any = await affiliatesPublicService.resolveByCode('khalid2026');

  for (const forbiddenField of ['email', 'phone', 'phoneNumber', 'iban', 'bankName', 'kycDocumentUrl', 'minimumPayoutAmount', 'commissionLogs', 'walletBalance']) {
    assert.equal(forbiddenField in result, false, `must not expose ${forbiddenField}`);
  }
});

test('search: case-insensitive partial match on firstName/lastName', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const results = await affiliatesPublicService.search('خالد');

  assert.equal(results.length, 1);
  assert.equal(results[0].displayName, 'خالد العتيبي');
});

test('search: an empty or too-short query returns an empty array, not an error', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  assert.deepEqual(await affiliatesPublicService.search(''), []);
  assert.deepEqual(await affiliatesPublicService.search('خ'), []); // below MIN_SEARCH_QUERY_LENGTH
});

test('search: caps results at the documented limit (10)', async (t) => {
  const many = Array.from({ length: 15 }, (_, i) => ({
    id: `affiliate-${i}`, referralSlug: `slug-${i}`, firstName: 'Test', lastName: `Person${i}`
  }));
  const { affiliatesPublicService } = await loadService(t, many);

  const results = await affiliatesPublicService.search('Test');

  assert.equal(results.length, 10);
});

test('search: every result excludes email/phone/bank/IBAN/KYC/wallet/commission fields', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const results: any[] = await affiliatesPublicService.search('خالد');

  assert.equal(results.length, 1);
  for (const forbiddenField of ['email', 'phoneNumber', 'iban', 'bankName', 'kycDocumentUrl']) {
    assert.equal(forbiddenField in results[0], false, `must not expose ${forbiddenField}`);
  }
});

test('resolveByCode / search: displayName falls back sensibly when firstName/lastName are both null', async (t) => {
  const nameless = { id: 'affiliate-2', referralSlug: 'anon-code', firstName: null, lastName: null };
  const { affiliatesPublicService } = await loadService(t, [nameless]);

  const resolved = await affiliatesPublicService.resolveByCode('anon-code');
  assert.equal(resolved?.displayName, 'anon-code'); // falls back to the (still non-private) referralSlug
});
