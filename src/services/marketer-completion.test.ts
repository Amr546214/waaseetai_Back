import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { updateMarketingInfoSchema, addChannelSchema } from '../dtos/marketer-profile.dto';

// Marketer completion: GET /marketer/profile recomputes and returns what is missing; writes recompute; input validation.

const FULL = (over: any = {}) => ({
  id: 'aff-1', userId: 'user-1', avatarUrl: 'https://x/a.png', bio: 'x'.repeat(60), paypalPayoutEmail: 'm@example.com', iban: 'SA5503000000608010167519', bankName: 'Old', completionPercentage: 45,
  user: { firstName: 'A', lastName: 'B', email: 'a@b.co', phoneNumber: null, phoneCountryCode: null, idNumber: null, avatarUrl: null },
  marketingChannels: [{ id: 'c1', platform: 'YOUTUBE', handle: 'x' }], ...over,
});

async function load(t: TestContext, opts: { profile: any }) {
  const updateSpy = t.mock.fn((args: any) => ({ id: 'aff-1', ...args.data }));
  t.mock.module('../config/db', { namedExports: { prisma: {
    affiliateProfile: { findUnique: async () => opts.profile, update: updateSpy },
  } } });
  const { marketerProfileService } = await import(`./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: marketerProfileService, updateSpy };
}

test('GET: a complete marketer is 100 with nothing missing; the stale stored value is healed', async (t) => {
  const { service, updateSpy } = await load(t, { profile: FULL() });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 100);
  assert.deepEqual(p.missingItems, []);
  assert.equal(p.paypalPayoutEmail, 'm@example.com');
  for (const k of ['iban', 'bankName', 'accountHolderName', 'swiftCode', 'bankStatus']) assert.equal(k in p, false, `${k} must not be returned`);
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.completionPercentage, 100);
});

test('GET: names and email earn nothing (an empty profile is 0)', async (t) => {
  const { service } = await load(t, { profile: FULL({ avatarUrl: null, bio: null, paypalPayoutEmail: null, marketingChannels: [], completionPercentage: 0 }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 0);
  assert.deepEqual(p.missingItems.map((i: any) => [i.key, i.points, i.status]), [['avatar', 20, 'missing'], ['bio', 20, 'missing'], ['channel', 30, 'missing'], ['payout', 30, 'missing']]);
});

test('GET: without a PayPal email the payout item is missing (an old IBAN on the row earns nothing and is not returned)', async (t) => {
  const { service } = await load(t, { profile: FULL({ paypalPayoutEmail: null }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.completionPercentage, 70);
  assert.deepEqual(p.missingItems.map((i: any) => [i.key, i.status, i.tab]), [['payout', 'missing', 'bank']]);
  assert.equal('iban' in p, false);
});

test('GET: a bio of 49 characters is listed as missing', async (t) => {
  const { service } = await load(t, { profile: FULL({ bio: 'x'.repeat(49) }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.missingItems.some((i: any) => i.key === 'bio'), true);
  assert.equal(p.completionPercentage, 80);
});

test('GET: a bio of exactly 50 characters counts', async (t) => {
  const { service } = await load(t, { profile: FULL({ bio: 'x'.repeat(50) }) });
  const p = await service.getProfile('user-1');
  assert.equal(p.missingItems.some((i: any) => i.key === 'bio'), false);
  assert.equal(p.completionPercentage, 100);
});

test('recalculateCompletion: uses the transaction client it is given (legacy AFFILIATE paths see their own uncommitted writes)', async (t) => {
  const { service } = await load(t, { profile: FULL({ paypalPayoutEmail: null }) });
  const txUpdate = t.mock.fn((args: any) => ({ id: 'aff-1', ...args.data }));
  const tx: any = { affiliateProfile: { findUnique: async () => ({ avatarUrl: 'x', bio: null, marketingChannels: [], user: {} }), update: txUpdate } };
  await service.recalculateCompletion('user-1', tx);
  assert.equal(txUpdate.mock.calls[0].arguments[0].data.completionPercentage, 20);
});

test('validation: bio max 500 (empty and short bios are allowed, they just do not count)', () => {
  assert.equal(updateMarketingInfoSchema.safeParse({ bio: 'x'.repeat(500) }).success, true);
  assert.equal(updateMarketingInfoSchema.safeParse({ bio: '' }).success, true);
  assert.equal(updateMarketingInfoSchema.safeParse({ bio: 'قصير' }).success, true);
  const long = updateMarketingInfoSchema.safeParse({ bio: 'x'.repeat(501) });
  assert.equal(long.success, false);
  assert.match(long.error!.issues[0].message, /500/);
  assert.equal(updateMarketingInfoSchema.safeParse({ avatarUrl: '', bio: null }).success, true);
});

test('validation: channel platform must be known (case-insensitive) and the handle non-empty', () => {
  const ok = addChannelSchema.safeParse({ platform: 'youtube', handle: '  @channel ' });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data && { platform: ok.data.platform, handle: ok.data.handle }, { platform: 'YOUTUBE', handle: '@channel' });
  for (const platform of ['LINKEDIN', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'TWITTER', 'INSTAGRAM']) assert.equal(addChannelSchema.safeParse({ platform, handle: 'x' }).success, true, platform);
  const unknown = addChannelSchema.safeParse({ platform: 'MYSPACE', handle: 'x' });
  assert.equal(unknown.success, false);
  assert.match(unknown.error!.issues[0].message, /نوع القناة/);
  assert.equal(addChannelSchema.safeParse({ platform: 'TIKTOK', handle: '   ' }).success, false);
  assert.equal(addChannelSchema.safeParse({ platform: 'TIKTOK' }).success, false);
  assert.equal(addChannelSchema.safeParse({ handle: 'x' }).success, false);
});
