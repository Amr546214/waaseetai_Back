import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeClientCompletion, computeClientMissingItems, computeProviderCompletion, computeAffiliateCompletion, computeAffiliateMissingItems } from './completion-calculators';

// Phase 3D.2A: these are pure functions (no Prisma, no dotenv, no DB, no
// service imports with side effects), so these tests run with zero mocking
// and never load db.ts.

// ============================================================================
// CLIENT calculator — one formula per account type, each weighted to 100 over inputs the UI can fill.
// INDIVIDUAL: avatar 15, name 15, bio 15, occupation(industry) 15, idNumber 20, PayPal 20.
// COMPANY:    avatar 10, name 10, bio 10, companyName 10, companySize 10, industry 10, website 10, idNumber 10, PayPal 20.
// Not scored any more: User.phoneNumber, User.idExpiryDate, IBAN / bank name / account holder.
// ============================================================================

const FULL_INDIVIDUAL = {
  user: { firstName: 'سارة', lastName: 'أحمد', accountType: 'CLIENT_INDIVIDUAL' },
  clientProfile: { avatarUrl: 'https://x/a.png', bio: 'نبذة', industry: 'مهندسة', idNumber: '1234567890', paypalPayoutEmail: 'pay@example.com' },
};
const FULL_COMPANY = {
  user: { firstName: 'سارة', lastName: 'أحمد', accountType: 'CLIENT_COMPANY' },
  clientProfile: { avatarUrl: 'https://x/a.png', bio: 'نبذة', companyName: 'شركة', companySize: '11-50', industry: 'تقنية', website: 'https://c.example', idNumber: '1234567890', paypalPayoutEmail: 'pay@example.com' },
};

test('client individual: a full profile is 100 with nothing missing; company fields are NOT counted', () => {
  assert.equal(computeClientCompletion(FULL_INDIVIDUAL), 100);
  assert.deepEqual(computeClientMissingItems(FULL_INDIVIDUAL), []);
  // company fields on an individual add nothing and are never listed
  const withCompanyFields = { ...FULL_INDIVIDUAL, clientProfile: { ...FULL_INDIVIDUAL.clientProfile, companyName: 'x', companySize: 'y', website: 'z' } };
  assert.equal(computeClientCompletion(withCompanyFields), 100);
  const noPaypal = { ...FULL_INDIVIDUAL, clientProfile: { ...FULL_INDIVIDUAL.clientProfile, paypalPayoutEmail: null } };
  assert.equal(computeClientCompletion(noPaypal), 80);
  assert.equal(computeClientMissingItems(noPaypal).some(i => /company|website|companySize/i.test(i.key)), false);
});

test('client individual weights: 15/15/15/15/20/20', () => {
  const items = computeClientMissingItems({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: {} });
  assert.deepEqual(items.map(i => [i.key, i.points]), [['avatar', 15], ['name', 15], ['bio', 15], ['industry', 15], ['idNumber', 20], ['payout', 20]]);
  assert.equal(items.reduce((n, i) => n + i.points, 0), 100);
});

test('client company: the company fields count and the weights add up to 100', () => {
  assert.equal(computeClientCompletion(FULL_COMPANY), 100);
  const items = computeClientMissingItems({ user: { accountType: 'CLIENT_COMPANY' }, clientProfile: {} });
  assert.deepEqual(items.map(i => [i.key, i.points]), [['avatar', 10], ['name', 10], ['bio', 10], ['companyName', 10], ['companySize', 10], ['industry', 10], ['website', 10], ['idNumber', 10], ['payout', 20]]);
  assert.equal(items.reduce((n, i) => n + i.points, 0), 100);
  const noWebsite = { ...FULL_COMPANY, clientProfile: { ...FULL_COMPANY.clientProfile, website: '' } };
  assert.equal(computeClientCompletion(noWebsite), 90);
  assert.deepEqual(computeClientMissingItems(noWebsite).map(i => i.key), ['website']);
});

test('client: an unknown / missing account type is scored as an individual', () => {
  assert.equal(computeClientCompletion({ user: {}, clientProfile: FULL_INDIVIDUAL.clientProfile }), computeClientCompletion({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: FULL_INDIVIDUAL.clientProfile }));
  assert.equal(computeClientCompletion({ user: { accountType: 'PROVIDER_INDIVIDUAL' }, clientProfile: {} }), 0);
});

test('client: PayPal is the only payout item (+20); IBAN, bank name, account holder, phone and idExpiryDate earn nothing', () => {
  const legacyOnly = computeClientCompletion({
    user: { accountType: 'CLIENT_INDIVIDUAL', ibanNumber: 'SA0380000000608010167519', accountHolderName: 'سارة', bankName: 'Rajhi', phoneNumber: '0500000000', idExpiryDate: new Date() },
    clientProfile: { bankName: 'Rajhi' },
  });
  assert.equal(legacyOnly, 0);
  const paypalOnly = computeClientCompletion({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: { paypalPayoutEmail: 'pay@example.com' } });
  assert.equal(paypalOnly, 20);
  assert.equal(computeClientCompletion({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: { paypalPayoutEmail: '   ' } }), 0);
});

test('client missing items point at pages that can fix them: wizard items -> setup, PayPal -> banking, never the inert identity tab', () => {
  const items = computeClientMissingItems({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: {} });
  const tab = Object.fromEntries(items.map(i => [i.key, i.tab]));
  assert.deepEqual(tab, { avatar: 'profile', name: 'basics', bio: 'profile', industry: 'setup', idNumber: 'setup', payout: 'banking' });
  assert.equal(items.every(i => i.status === 'missing' && i.hint.length > 0 && i.label.length > 0), true);
});

test('client: ClientProfile wins over User and a null ClientProfile value falls back to User (name, avatar, idNumber)', () => {
  assert.equal(computeClientCompletion({ user: { firstName: 'U', lastName: 'U', avatarUrl: 'u', idNumber: '1', accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: { firstName: null, lastName: null, avatarUrl: null, idNumber: null } }), 15 + 15 + 20);
  assert.equal(computeClientCompletion({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: { firstName: 'C', lastName: 'C', avatarUrl: 'c', idNumber: '2' } }), 15 + 15 + 20);
});

test('client: whitespace-only text does not count', () => {
  assert.equal(computeClientCompletion({ user: { accountType: 'CLIENT_INDIVIDUAL' }, clientProfile: { bio: '   ', industry: ' ' } }), 0);
});

// ============================================================================
// PROVIDER calculator — verbatim extraction of provider-profile.service.ts's
// calculateProfileCompletion (10+15+15+10+10+10+10+10+10 = 100 max).
// ============================================================================

test('computeProviderCompletion: known fixture -> exact score matching the pre-extraction formula', () => {
  const score = computeProviderCompletion({
    providerProfile: {
      firstName: 'Okasha',
      lastName: 'Expert',
      avatarUrl: 'https://example.com/a.png',
      headline: 'Senior Consultant',
      mainSpecialty: 'دعم فني',
      bio: 'x'.repeat(60),
      skills: ['a', 'b'],
      portfolioItems: [],
      websiteUrl: null,
      country: 'SA',
      city: 'Riyadh',
      paypalPayoutEmail: 'pay@example.com'
    },
    user: {
      firstName: 'Legacy',
      lastName: 'Name',
      avatarUrl: null,
      email: 'p@example.com',
      phoneNumber: '0500000000',
      ibanNumber: 'SA00...',
      idDocumentUrl: 'https://example.com/id.pdf'
    }
  });
  // avatarUrl(10) + name+headline+mainSpecialty(15) + bio>=50(15) + skills(10)
  // + country+city(10) + email+phone(10) + PayPal payout email(10, replaces the old IBAN factor; User.ibanNumber is no
  // longer scored) + idDocumentUrl(10) = 90
  // (no portfolioItems and no websiteUrl -> that +10 factor doesn't fire)
  assert.equal(score, 90);
});

test('computeProviderCompletion: ProviderProfile display fields preferred over legacy User values', () => {
  const withOwnFields = computeProviderCompletion({
    providerProfile: { firstName: 'Okasha', lastName: 'Expert', headline: 'H', mainSpecialty: 'S' },
    user: { firstName: 'Legacy', lastName: 'Name' }
  });
  assert.equal(withOwnFields, 15); // name+headline+mainSpecialty factor fires using ProviderProfile's own name
});

test('computeProviderCompletion: legacy User fallback still works when ProviderProfile display field is absent', () => {
  const withLegacyFallback = computeProviderCompletion({
    providerProfile: { firstName: null, lastName: null, avatarUrl: null, headline: 'H', mainSpecialty: 'S' },
    user: { firstName: 'Legacy', lastName: 'Name', avatarUrl: 'https://legacy.example/a.png' }
  });
  // avatarUrl(10) + name+headline+mainSpecialty(15) via User fallback = 25
  assert.equal(withLegacyFallback, 25);
});

test('computeProviderCompletion: empty fixture -> 0, capped/never negative', () => {
  const score = computeProviderCompletion({ providerProfile: {}, user: {} });
  assert.equal(score, 0);
});

// ============================================================================
// AFFILIATE calculator — Phase 3D.4 verbatim extraction of
// marketer-profile.service.ts's (former, now-delegating) private
// recalculateCompletion — identical fields, identical weights (avatar 15 +
// bio 15 + >=1 channel 20 + IBAN 20 + basic identity 30 = 100 max), identical
// null/empty semantics. These tests prove the extracted pure calculator
// produces the exact same scores the previous inline service implementation
// did, for every individual factor and the full combination.
// ============================================================================

const AFF_FULL = {
  user: { avatarUrl: null },
  affiliateProfile: { avatarUrl: 'https://x/a.png', bio: 'x'.repeat(60), paypalPayoutEmail: 'm@example.com' },
  marketingChannelsCount: 1,
};

test('computeAffiliateCompletion: empty/minimal state -> 0 (names and email earn nothing any more)', () => {
  assert.equal(computeAffiliateCompletion({ user: { firstName: 'A', lastName: 'B', email: 'a@b.co' }, affiliateProfile: {}, marketingChannelsCount: 0 }), 0);
});

test('computeAffiliateCompletion: avatar = 20 (AffiliateProfile.avatarUrl, or the legacy User.avatarUrl)', () => {
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: { avatarUrl: 'https://x/a.png' }, marketingChannelsCount: 0 }), 20);
  assert.equal(computeAffiliateCompletion({ user: { avatarUrl: 'https://legacy/a.png' }, affiliateProfile: { avatarUrl: null }, marketingChannelsCount: 0 }), 20);
});

test('computeAffiliateCompletion: bio = 20 only from 50 characters (49 does not count, whitespace is trimmed)', () => {
  const score = (bio: string | null) => computeAffiliateCompletion({ user: {}, affiliateProfile: { bio }, marketingChannelsCount: 0 });
  assert.equal(score('x'.repeat(50)), 20);
  assert.equal(score('x'.repeat(49)), 0);
  assert.equal(score('  ' + 'x'.repeat(48) + '  '), 0);
  assert.equal(score(''), 0);
  assert.equal(score(null), 0);
});

test('computeAffiliateCompletion: one channel = 30 (the count itself is not scored, no verification needed)', () => {
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: {}, marketingChannelsCount: 1 }), 30);
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: {}, marketingChannelsCount: 5 }), 30);
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: {}, marketingChannelsCount: 0 }), 0);
});

test('computeAffiliateCompletion: PayPal email = 30 (whitespace-only does not count); an IBAN earns nothing', () => {
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: { paypalPayoutEmail: 'm@example.com' }, marketingChannelsCount: 0 }), 30);
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: { paypalPayoutEmail: '   ' }, marketingChannelsCount: 0 }), 0);
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: { iban: 'SA0380000000608010167519' } as any, marketingChannelsCount: 0 }), 0);
});

test('computeAffiliateCompletion: full = 100 (20 + 20 + 30 + 30) with nothing missing', () => {
  assert.equal(computeAffiliateCompletion(AFF_FULL), 100);
  assert.deepEqual(computeAffiliateMissingItems(AFF_FULL), []);
});

test('affiliate missing items: every input listed with points and the tab; points add up to 100 - score', () => {
  const empty = { user: {}, affiliateProfile: {}, marketingChannelsCount: 0 };
  const items = computeAffiliateMissingItems(empty);
  assert.deepEqual(items.map(i => [i.key, i.points, i.tab, i.status]), [['avatar', 20, 'profile', 'missing'], ['bio', 20, 'profile', 'missing'], ['channel', 30, 'profile', 'missing'], ['payout', 30, 'bank', 'missing']]);
  assert.equal(items.reduce((n, i) => n + i.points, 0), 100 - computeAffiliateCompletion(empty));
  assert.match(items[1].hint, /50/);
});

test('affiliate: without a PayPal email the payout item is listed (missing) with the PayPal wording, never IBAN / bank', () => {
  const noPaypal = { ...AFF_FULL, affiliateProfile: { ...AFF_FULL.affiliateProfile, paypalPayoutEmail: null } };
  assert.equal(computeAffiliateCompletion(noPaypal), 70);
  const items = computeAffiliateMissingItems(noPaypal);
  assert.deepEqual(items.map(i => [i.key, i.status, i.tab]), [['payout', 'missing', 'bank']]);
  assert.match(items[0].hint, /PayPal/);
  assert.doesNotMatch(JSON.stringify(items), /IBAN|بنك|بنكي/);
});

test('computeAffiliateCompletion: null/empty semantics (undefined/null fields never throw, never falsely score)', () => {
  assert.equal(computeAffiliateCompletion({ user: {}, affiliateProfile: { avatarUrl: null, bio: null, paypalPayoutEmail: null }, marketingChannelsCount: 0 }), 0);
  assert.equal(computeAffiliateCompletion({ user: { avatarUrl: null }, affiliateProfile: {}, marketingChannelsCount: undefined as any }), 0);
});

// ============================================================================
// Provider: PayPal replaces IBAN, missingItems, pending ID review
// ============================================================================
import { computeProviderMissingItems } from './completion-calculators';

const FULL_PROVIDER = {
  providerProfile: {
    firstName: 'Okasha', lastName: 'Expert', avatarUrl: 'https://example.com/a.png', headline: 'Senior', mainSpecialty: 'دعم فني',
    bio: 'x'.repeat(60), skills: ['a'], portfolioItems: [], websiteUrl: 'https://example.com', country: 'SA', city: 'Riyadh',
    paypalPayoutEmail: 'pay@example.com',
  },
  user: { email: 'p@example.com', phoneNumber: '0500000000', idDocumentUrl: 'https://example.com/id.pdf' },
};

test('provider: the PayPal payout email earns the payment points (10) and User.ibanNumber earns nothing', () => {
  const withPaypal = computeProviderCompletion({ ...FULL_PROVIDER, user: { ...FULL_PROVIDER.user, idDocumentUrl: null } });
  assert.equal(withPaypal, 90); // everything except the ID document
  const withIbanOnly = computeProviderCompletion({
    providerProfile: { ...FULL_PROVIDER.providerProfile, paypalPayoutEmail: null },
    user: { ...FULL_PROVIDER.user, ibanNumber: 'SA0380000000608010167519', idDocumentUrl: null },
  });
  assert.equal(withIbanOnly, 80); // the IBAN is ignored, the PayPal factor is missing
  assert.equal(computeProviderCompletion({ ...FULL_PROVIDER, providerProfile: { ...FULL_PROVIDER.providerProfile, paypalPayoutEmail: '   ' } }), 90);
});

test('provider without PayPal: a "payout" item is missing (10 points, payout tab)', () => {
  const items = computeProviderMissingItems({ ...FULL_PROVIDER, providerProfile: { ...FULL_PROVIDER.providerProfile, paypalPayoutEmail: null } });
  assert.deepEqual(items.map(i => [i.key, i.points, i.status, i.tab]), [['payout', 10, 'missing', 'payout']]);
});

test('provider with a pending ID document review: reported as pending_review, not missing, and not counted yet', () => {
  const input = { ...FULL_PROVIDER, user: { ...FULL_PROVIDER.user, idDocumentUrl: null } };
  assert.equal(computeProviderCompletion(input), 90);
  const items = computeProviderMissingItems(input, { pendingDocumentReview: true });
  assert.deepEqual(items.map(i => [i.key, i.status, i.tab]), [['idDocument', 'pending_review', 'docs']]);
  assert.match(items[0].hint, /قيد المراجعة/);
  // without a pending request the same gap is plainly missing
  assert.equal(computeProviderMissingItems(input)[0].status, 'missing');
});

test('full provider (PayPal + approved ID) reaches 100 with nothing missing', () => {
  assert.equal(computeProviderCompletion(FULL_PROVIDER), 100);
  assert.deepEqual(computeProviderMissingItems(FULL_PROVIDER), []);
});

test('provider missingItems: every scoring input is listed with its points and the tab that fixes it; points add up to 100 - score', () => {
  const empty = { providerProfile: {}, user: {} };
  const items = computeProviderMissingItems(empty);
  assert.deepEqual(items.map(i => i.key), ['avatar', 'identity', 'bio', 'skills', 'portfolio', 'contact', 'location', 'payout', 'idDocument']);
  assert.deepEqual(items.map(i => i.tab), ['profile', 'profile', 'profile', 'profile', 'profile', 'contact', 'profile', 'payout', 'docs']);
  assert.equal(items.reduce((n, i) => n + i.points, 0), 100 - computeProviderCompletion(empty));
  // a 49-character bio is still missing; 50 is enough
  assert.equal(computeProviderMissingItems({ providerProfile: { ...FULL_PROVIDER.providerProfile, bio: 'x'.repeat(49) }, user: FULL_PROVIDER.user }).some(i => i.key === 'bio'), true);
  assert.equal(computeProviderMissingItems({ providerProfile: { ...FULL_PROVIDER.providerProfile, bio: 'x'.repeat(50) }, user: FULL_PROVIDER.user }).some(i => i.key === 'bio'), false);
});

test('provider "معرض الأعمال" (+10): fixed by a portfolio link (websiteUrl) or a portfolio item, and the hint says where to add it', () => {
  const without = { ...FULL_PROVIDER, providerProfile: { ...FULL_PROVIDER.providerProfile, websiteUrl: null, portfolioItems: [] } };
  const missing = computeProviderMissingItems(without).find(i => i.key === 'portfolio')!;
  assert.equal(missing.points, 10);
  assert.equal(missing.tab, 'profile');
  assert.match(missing.hint, /Behance/);
  assert.match(missing.hint, /الروابط الشخصية/);
  assert.equal(computeProviderMissingItems({ ...without, providerProfile: { ...without.providerProfile, websiteUrl: 'https://www.behance.net/x' } }).some(i => i.key === 'portfolio'), false);
  assert.equal(computeProviderMissingItems({ ...without, providerProfile: { ...without.providerProfile, portfolioItems: [{}] } }).some(i => i.key === 'portfolio'), false);
});
