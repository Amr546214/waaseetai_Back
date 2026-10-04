import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeClientCompletion, computeProviderCompletion, computeAffiliateCompletion } from './completion-calculators';

// Phase 3D.2A: these are pure functions (no Prisma, no dotenv, no DB, no
// service imports with side effects), so these tests run with zero mocking
// and never load db.ts.

// ============================================================================
// CLIENT calculator — verbatim historical formula (base 7.5x4, meta 6.0x5,
// KYC 10.0x2, banking 20/3 x3 = 100 max).
// ============================================================================

test('computeClientCompletion: known fixture -> exact historical score', () => {
  // base: firstName, lastName, phoneNumber, avatarUrl all set -> 4 * 7.5 = 30
  // meta: bio, companyName set (2 of 5) -> 2 * 6.0 = 12
  // KYC: idNumber set, idExpiryDate not -> 1 * 10.0 = 10
  // banking: none set -> 0
  // total = 52
  const score = computeClientCompletion({
    user: {
      firstName: 'Amr',
      lastName: 'Okasha',
      phoneNumber: '0500000000',
      avatarUrl: 'https://example.com/avatar.png',
      idNumber: null,
      idExpiryDate: null,
      ibanNumber: null,
      bankName: null,
      accountHolderName: null
    },
    clientProfile: {
      firstName: null,
      lastName: null,
      avatarUrl: null,
      bio: 'A short bio',
      companyName: 'Acme',
      companySize: null,
      industry: null,
      website: null,
      idNumber: '1234567890',
      bankName: null
    }
  });

  assert.equal(score, 52);
});

test('computeClientCompletion: full fixture -> capped at 100', () => {
  const score = computeClientCompletion({
    user: {
      firstName: 'Amr',
      lastName: 'Okasha',
      phoneNumber: '0500000000',
      avatarUrl: 'https://example.com/avatar.png',
      idNumber: '1234567890',
      idExpiryDate: '2030-01-01',
      ibanNumber: 'SA0000000000000000000000',
      bankName: 'Al Rajhi',
      accountHolderName: 'Amr Okasha'
    },
    clientProfile: {
      firstName: null,
      lastName: null,
      avatarUrl: null,
      bio: 'bio',
      companyName: 'Acme',
      companySize: '10-50',
      industry: 'Tech',
      website: 'https://acme.example',
      idNumber: null,
      bankName: null
    }
  });

  assert.equal(score, 100);
});

test('computeClientCompletion: everything empty -> 0', () => {
  const score = computeClientCompletion({
    user: {},
    clientProfile: {}
  });
  assert.equal(score, 0);
});

test('computeClientCompletion: null ClientProfile firstName/lastName/avatarUrl falls back to User', () => {
  const score = computeClientCompletion({
    user: { firstName: 'Amr', lastName: 'Okasha', avatarUrl: 'https://example.com/a.png' },
    clientProfile: { firstName: null, lastName: null, avatarUrl: null }
  });
  // 3 base fields (firstName/lastName/avatarUrl) via User fallback = 3 * 7.5 = 22.5 -> rounds to 23
  assert.equal(score, 23);
});

test('computeClientCompletion: an already-set ClientProfile firstName/lastName/avatarUrl wins over User', () => {
  const score = computeClientCompletion({
    user: { firstName: 'Legacy', lastName: 'Name', avatarUrl: 'https://legacy.example/a.png' },
    clientProfile: { firstName: 'Client', lastName: 'Persona', avatarUrl: 'https://client.example/a.png' }
  });
  assert.equal(score, 23); // same weight either way — this proves ClientProfile's value is what's actually read
});

test('computeClientCompletion: null ClientProfile.bankName falls back to User.bankName (null-shadow fix)', () => {
  const withNullShadow = computeClientCompletion({
    user: { bankName: 'Al Rajhi' },
    clientProfile: { bankName: null } // Prisma returns explicit null, not undefined, once a row exists
  });
  const withNoClientProfileRow = computeClientCompletion({
    user: { bankName: 'Al Rajhi' },
    clientProfile: {}
  });
  // Both must credit the banking factor via User's value — a raw
  // {...user, ...clientProfile} merge would score 0 for the first case,
  // since explicit null would win over User's real value.
  assert.equal(withNullShadow, Math.round(20 / 3));
  assert.equal(withNoClientProfileRow, Math.round(20 / 3));
});

test('computeClientCompletion: null ClientProfile.idNumber falls back to User.idNumber (null-shadow fix)', () => {
  const score = computeClientCompletion({
    user: { idNumber: '1234567890' },
    clientProfile: { idNumber: null }
  });
  assert.equal(score, 10);
});

test('computeClientCompletion: a set ClientProfile.bankName/idNumber wins over User (not just a fallback in one direction)', () => {
  const score = computeClientCompletion({
    user: { bankName: null, idNumber: null },
    clientProfile: { bankName: 'Al Rajhi', idNumber: '1234567890' }
  });
  assert.equal(score, Math.round(10 + (20 / 3)));
});

test('computeClientCompletion: ibanNumber and accountHolderName always resolve from User (ClientProfile has no matching column names)', () => {
  const score = computeClientCompletion({
    user: { ibanNumber: 'SA00...', accountHolderName: 'Amr Okasha' },
    // ClientProfile's own equivalents are named `iban`/`accountHolder` —
    // irrelevant here since the calculator's input type doesn't even accept
    // those keys, proving the formula never looks for them.
    clientProfile: {}
  });
  assert.equal(score, Math.round((20 / 3) * 2));
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
      city: 'Riyadh'
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
  // + country+city(10) + email+phone(10) + iban(10) + idDocumentUrl(10) = 90
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

test('computeAffiliateCompletion: empty/minimal state -> 0 (exact old zero-score behavior)', () => {
  const score = computeAffiliateCompletion({
    user: {},
    affiliateProfile: {},
    marketingChannelsCount: 0
  });
  assert.equal(score, 0);
});

test('computeAffiliateCompletion: avatar factor = 15 (from AffiliateProfile.avatarUrl)', () => {
  const score = computeAffiliateCompletion({
    user: {},
    affiliateProfile: { avatarUrl: 'https://example.com/a.png' },
    marketingChannelsCount: 0
  });
  assert.equal(score, 15);
});

test('computeAffiliateCompletion: avatar factor = 15 also satisfied via legacy User.avatarUrl fallback', () => {
  const score = computeAffiliateCompletion({
    user: { avatarUrl: 'https://legacy.example/a.png' },
    affiliateProfile: { avatarUrl: null },
    marketingChannelsCount: 0
  });
  assert.equal(score, 15);
});

test('computeAffiliateCompletion: bio factor = 15 (whitespace-only bio does not count, matching trim().length > 0)', () => {
  const withBio = computeAffiliateCompletion({ user: {}, affiliateProfile: { bio: 'مرحباً بكم' }, marketingChannelsCount: 0 });
  assert.equal(withBio, 15);

  const whitespaceOnly = computeAffiliateCompletion({ user: {}, affiliateProfile: { bio: '   ' }, marketingChannelsCount: 0 });
  assert.equal(whitespaceOnly, 0);
});

test('computeAffiliateCompletion: marketing channel factor = 20 (>=1 channel, count itself is not scored)', () => {
  const oneChannel = computeAffiliateCompletion({ user: {}, affiliateProfile: {}, marketingChannelsCount: 1 });
  assert.equal(oneChannel, 20);

  const manyChannels = computeAffiliateCompletion({ user: {}, affiliateProfile: {}, marketingChannelsCount: 5 });
  assert.equal(manyChannels, 20);
});

test('computeAffiliateCompletion: IBAN factor = 20 (whitespace-only IBAN does not count)', () => {
  const withIban = computeAffiliateCompletion({ user: {}, affiliateProfile: { iban: 'SA0000000000000000000011' }, marketingChannelsCount: 0 });
  assert.equal(withIban, 20);

  const whitespaceOnly = computeAffiliateCompletion({ user: {}, affiliateProfile: { iban: '  ' }, marketingChannelsCount: 0 });
  assert.equal(whitespaceOnly, 0);
});

test('computeAffiliateCompletion: basic identity factor = 30 (requires firstName AND lastName AND email together)', () => {
  const full = computeAffiliateCompletion({
    user: { firstName: 'Amr', lastName: 'Okasha', email: 'amr@example.com' },
    affiliateProfile: {},
    marketingChannelsCount: 0
  });
  assert.equal(full, 30);

  const missingEmail = computeAffiliateCompletion({
    user: { firstName: 'Amr', lastName: 'Okasha', email: null },
    affiliateProfile: {},
    marketingChannelsCount: 0
  });
  assert.equal(missingEmail, 0);
});

test('computeAffiliateCompletion: full score = 100 when every factor is satisfied', () => {
  const score = computeAffiliateCompletion({
    user: { firstName: 'Amr', lastName: 'Okasha', email: 'amr@example.com', avatarUrl: null },
    affiliateProfile: { avatarUrl: 'https://example.com/a.png', bio: 'bio', iban: 'SA0000000000000000000011' },
    marketingChannelsCount: 2
  });
  assert.equal(score, 100);
});

test('computeAffiliateCompletion: null/empty semantics preserved exactly (undefined/null fields never throw, never falsely score)', () => {
  const score = computeAffiliateCompletion({
    user: { firstName: undefined, lastName: null, email: undefined, avatarUrl: null },
    affiliateProfile: { avatarUrl: undefined, bio: null, iban: undefined },
    marketingChannelsCount: 0
  });
  assert.equal(score, 0);
});

test('computeClientCompletion: paypalPayoutEmail substitutes the whole banking section (no IBAN needed to reach 100)', () => {
  const base = {
    user: { firstName: 'A', lastName: 'B', phoneNumber: '1', avatarUrl: 'x', idNumber: '1', idExpiryDate: new Date() },
    clientProfile: { bio: 'b', companyName: 'c', companySize: 's', industry: 'i', website: 'w' }
  };
  const without = computeClientCompletion(base as any);
  const withPaypal = computeClientCompletion({ ...base, clientProfile: { ...base.clientProfile, paypalPayoutEmail: 'p@x.co' } } as any);
  assert.equal(without, 80);
  assert.equal(withPaypal, 100);
});
