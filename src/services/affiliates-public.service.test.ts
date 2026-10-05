import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// GET /api/affiliates/resolve and GET /api/affiliates/search are PUBLIC and
// UNAUTHENTICATED (used during registration, before an account exists) — so
// the response shape must be provably PII-safe: only { id, referralSlug,
// displayName, levelName, verified, avatarUrl }, never email/phone/bank/IBAN/KYC/wallet/commission/numeric level
// data, regardless of what fields exist on the underlying AffiliateProfile row. Only ACTIVE affiliates are visible.

// A faithful mini-evaluator of the Prisma `where` shapes this service builds (AND / OR / contains / equals with
// mode:'insensitive' / not / user.status / plain equality), so the tests exercise the real filters.
function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'AND') return (cond as any[]).every(c => matches(row, c));
    if (key === 'OR') return (cond as any[]).some(c => matches(row, c));
    if (key === 'user') return Object.entries(cond).every(([k, v]) => row.user?.[k] === v);
    const value = row[key];
    if (cond !== null && typeof cond === 'object') {
      const ci = (x: any) => (cond.mode === 'insensitive' ? String(x ?? '').toLowerCase() : String(x ?? ''));
      if ('contains' in cond) return ci(value).includes(ci(cond.contains));
      if ('equals' in cond) return value != null && ci(value) === ci(cond.equals);
      if ('not' in cond) return value !== cond.not;
      return false;
    }
    return value === cond;
  });
}

function createAffiliatesPublicMockPrisma(t: TestContext, affiliates: any[]) {
  // The real DB only returns what `select` lists: project to exactly that so a widened select would be caught.
  const project = (row: any, select: any) => {
    const out: any = {};
    for (const key of Object.keys(select)) if (select[key]) out[key] = row[key] ?? null;
    return out;
  };
  const findFirstSpy = t.mock.fn(async (args: any) => {
    const row = affiliates.find(a => matches(a, args.where));
    return row ? project(row, args.select) : null;
  });
  const findManySpy = t.mock.fn(async (args: any) => {
    const rows = affiliates.filter(a => matches(a, args.where));
    return rows.slice(0, args.take ?? rows.length).map(r => project(r, args.select));
  });
  t.mock.module('../config/db', { namedExports: { prisma: { affiliateProfile: { findFirst: findFirstSpy, findMany: findManySpy } } } });
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
  currentLevel: 'موصل',
  identityVerified: true,
  avatarUrl: 'https://example.com/a.png',
  user: { status: 'ACTIVE' },
  // columns that must never be exposed
  email: 'khalid@example.com',
  phoneNumber: '0500000000',
  iban: 'SA0000000000000000000000',
  bankName: 'Some Bank',
  kycDocumentUrl: 'https://example.com/kyc.pdf',
  minimumPayoutAmount: 300,
  commissionRatePercentage: 5,
  level: 7,
  payoutMethod: 'BANK_TRANSFER'
};
const FORBIDDEN_FIELDS = ['email', 'phone', 'phoneNumber', 'iban', 'bankName', 'kycDocumentUrl', 'minimumPayoutAmount', 'commissionRatePercentage', 'commissionLogs', 'walletBalance', 'payoutMethod', 'level', 'user', 'userId'];
const PUBLIC_KEYS = ['avatarUrl', 'displayName', 'id', 'levelName', 'referralSlug', 'verified'];
const make = (over: any) => ({ ...AFFILIATE_FIXTURE, ...over });

test('resolveByCode: found by referralSlug — returns the public shape only (old fields kept, levelName/verified/avatarUrl added)', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.resolveByCode('khalid2026');

  assert.deepEqual(result, {
    id: 'affiliate-1', referralSlug: 'khalid2026', displayName: 'خالد العتيبي',
    levelName: 'موصل', verified: true, avatarUrl: 'https://example.com/a.png'
  });
  assert.deepEqual(Object.keys(result!).sort(), PUBLIC_KEYS);
});

test('resolveByCode: the slug is case-insensitive', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  assert.equal((await affiliatesPublicService.resolveByCode('KHALID2026'))?.id, 'affiliate-1');
  assert.equal((await affiliatesPublicService.resolveByCode('  Khalid2026 '))?.id, 'affiliate-1');
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

test('resolveByCode: an inactive / suspended / pending affiliate is not resolved (by slug or by id)', async (t) => {
  for (const status of ['SUSPENDED', 'SUSPENDED_REVIEW', 'PENDING_VERIFICATION']) {
    await t.test(status, async (st) => {
      const { affiliatesPublicService } = await loadService(st, [make({ user: { status } })]);
      assert.equal(await affiliatesPublicService.resolveByCode('khalid2026'), null);
      assert.equal(await affiliatesPublicService.resolveByCode('affiliate-1'), null);
    });
  }
});

test('resolveByCode: response never contains email/phone/bank/IBAN/KYC/wallet/commission/payout/numeric-level fields, even though the underlying row has them', async (t) => {
  const { affiliatesPublicService, findFirstSpy } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result: any = await affiliatesPublicService.resolveByCode('khalid2026');

  for (const forbiddenField of FORBIDDEN_FIELDS) {
    assert.equal(forbiddenField in result, false, `must not expose ${forbiddenField}`);
  }
  // and the query itself never even selects them
  const select = findFirstSpy.mock.calls[0].arguments[0].select;
  assert.deepEqual(Object.keys(select).sort(), ['avatarUrl', 'currentLevel', 'firstName', 'id', 'identityVerified', 'lastName', 'referralSlug']);
});

test('search: by name — case-insensitive partial match on firstName/lastName, and every word must match', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE, make({ id: 'a2', referralSlug: 'sara-ads', firstName: 'Sara', lastName: 'Ali' })]);

  assert.deepEqual((await affiliatesPublicService.search('خالد')).map((r: any) => r.id), ['affiliate-1']);
  assert.deepEqual((await affiliatesPublicService.search('SARA')).map((r: any) => r.id), ['a2']);
  assert.deepEqual((await affiliatesPublicService.search('sara ali')).map((r: any) => r.id), ['a2']);
  assert.deepEqual(await affiliatesPublicService.search('sara okasha'), []);
});

test('search: by slug fragment', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE, make({ id: 'a2', referralSlug: 'sara-ads', firstName: 'Sara', lastName: 'Ali' })]);

  const results = await affiliatesPublicService.search('ID2026'); // fragment of "khalid2026", different case

  assert.deepEqual(results.map((r: any) => r.referralSlug), ['khalid2026']);
});

test('search: a full slug match is listed first, before partial name/slug matches', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [
    make({ id: 'partial-1', referralSlug: 'other-1', firstName: 'Sam', lastName: 'Sami' }),
    make({ id: 'partial-2', referralSlug: 'sam-extra', firstName: 'Someone', lastName: 'Else' }),
    make({ id: 'exact', referralSlug: 'sam', firstName: 'Nobody', lastName: 'Match' })
  ]);

  const results = await affiliatesPublicService.search('SAM');

  assert.equal(results[0].id, 'exact');
  assert.deepEqual(results.map((r: any) => r.id).sort(), ['exact', 'partial-1', 'partial-2']);
  assert.equal(new Set(results.map((r: any) => r.id)).size, results.length); // the exact match is not duplicated
});

test('search: an inactive / suspended affiliate never appears (by name, by slug fragment or by full slug)', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [
    make({ id: 'active', referralSlug: 'khalid-ok', firstName: 'Khalid', lastName: 'Active' }),
    make({ id: 'suspended', referralSlug: 'khalid-sus', firstName: 'Khalid', lastName: 'Suspended', user: { status: 'SUSPENDED' } }),
    make({ id: 'review', referralSlug: 'khalid-rev', firstName: 'Khalid', lastName: 'Review', user: { status: 'SUSPENDED_REVIEW' } }),
    make({ id: 'pending', referralSlug: 'khalid-pen', firstName: 'Khalid', lastName: 'Pending', user: { status: 'PENDING_VERIFICATION' } })
  ]);

  assert.deepEqual((await affiliatesPublicService.search('khalid')).map((r: any) => r.id), ['active']);
  assert.deepEqual((await affiliatesPublicService.search('khalid-sus')), []);
  assert.deepEqual((await affiliatesPublicService.search('-rev')), []);
});

test('search: an empty or too-short query returns an empty array, not an error', async (t) => {
  const { affiliatesPublicService, findManySpy } = await loadService(t, [AFFILIATE_FIXTURE]);

  assert.deepEqual(await affiliatesPublicService.search(''), []);
  assert.deepEqual(await affiliatesPublicService.search('خ'), []); // below MIN_SEARCH_QUERY_LENGTH
  assert.equal(findManySpy.mock.callCount(), 0);
});

test('search: caps results at the documented limit (10)', async (t) => {
  const many = Array.from({ length: 15 }, (_, i) => make({ id: `affiliate-${i}`, referralSlug: `slug-${i}`, firstName: 'Test', lastName: `Person${i}` }));
  const { affiliatesPublicService } = await loadService(t, many);

  const results = await affiliatesPublicService.search('Test');

  assert.equal(results.length, 10);
});

test('search: every result has the public shape and excludes email/phone/bank/IBAN/KYC/commission/payout/numeric-level fields', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const results: any[] = await affiliatesPublicService.search('خالد');

  assert.equal(results.length, 1);
  assert.deepEqual(Object.keys(results[0]).sort(), PUBLIC_KEYS);
  for (const forbiddenField of FORBIDDEN_FIELDS) {
    assert.equal(forbiddenField in results[0], false, `must not expose ${forbiddenField}`);
  }
});

test('shape: levelName comes from currentLevel, verified from identityVerified, avatarUrl is null when absent', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [make({ currentLevel: 'مساعد', identityVerified: false, avatarUrl: null })]);

  const r: any = await affiliatesPublicService.resolveByCode('khalid2026');

  assert.equal(r.levelName, 'مساعد');
  assert.equal(r.verified, false);
  assert.equal(r.avatarUrl, null);
});

// ---------------------------------------------------------------------------
// getReferralStatus (GET /api/affiliates/referral-status) — the frontend
// cannot read the httpOnly waseet_ref_code cookie itself, so it asks the
// backend whether a valid attribution currently exists via that cookie.
// Reuses resolveByCode() internally rather than duplicating the query.
// ---------------------------------------------------------------------------

test('getReferralStatus: a valid cookie value resolves — returns { active: true, referralSlug, displayName }', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.getReferralStatus('khalid2026');

  assert.deepEqual(result, { active: true, referralSlug: 'khalid2026', displayName: 'خالد العتيبي' });
});

test('getReferralStatus: an unknown/stale cookie value — returns { active: false }, never throws', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.getReferralStatus('does-not-exist');

  assert.deepEqual(result, { active: false });
});

test('getReferralStatus: an absent cookie (undefined) — returns { active: false } without querying the DB', async (t) => {
  const { affiliatesPublicService, findFirstSpy } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.getReferralStatus(undefined);

  assert.deepEqual(result, { active: false });
  assert.equal(findFirstSpy.mock.callCount(), 0);
});

test('getReferralStatus: an empty/whitespace-only cookie value — returns { active: false } without querying the DB', async (t) => {
  const { affiliatesPublicService, findFirstSpy } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result = await affiliatesPublicService.getReferralStatus('   ');

  assert.deepEqual(result, { active: false });
  assert.equal(findFirstSpy.mock.callCount(), 0);
});

test('getReferralStatus: response never contains email/phone/bank/IBAN/KYC/wallet/commission fields, even when active', async (t) => {
  const { affiliatesPublicService } = await loadService(t, [AFFILIATE_FIXTURE]);

  const result: any = await affiliatesPublicService.getReferralStatus('khalid2026');

  for (const forbiddenField of [...FORBIDDEN_FIELDS, 'id', 'levelName', 'verified', 'avatarUrl']) {
    assert.equal(forbiddenField in result, false, `must not expose ${forbiddenField}`);
  }
  assert.deepEqual(Object.keys(result).sort(), ['active', 'displayName', 'referralSlug']);
});

test('resolveByCode / search: displayName falls back sensibly when firstName/lastName are both null', async (t) => {
  const nameless = { id: 'affiliate-2', referralSlug: 'anon-code', firstName: null, lastName: null, user: { status: 'ACTIVE' } };
  const { affiliatesPublicService } = await loadService(t, [nameless]);

  const resolved = await affiliatesPublicService.resolveByCode('anon-code');
  assert.equal(resolved?.displayName, 'anon-code'); // falls back to the (still non-private) referralSlug
});
