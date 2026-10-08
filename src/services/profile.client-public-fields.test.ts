import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';

// Client public-profile edit: bio / interests / personal links / display prefs are stored on ClientProfile, come back from GET /profiles/me,
// and a body can never write anything else onto the client row. One in-memory ClientProfile row behind a mocked prisma.

function createDb(t: TestContext) {
  const state: any = {
    user: { id: 'c1', status: 'ACTIVE', phoneNumber: null, firstName: 'Nora', lastName: 'Q', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT' },
    clientProfile: { id: 'cp1', userId: 'c1', bio: null, interests: [], completionPercentage: 0 } as any
  };
  const tx: any = {
    user: { findUnique: async () => ({ ...state.user, clientProfile: state.clientProfile }), update: async (a: any) => ({ ...state.user, ...a.data }) },
    clientProfile: {
      upsert: async (a: any) => { state.clientProfile = { ...(state.clientProfile || {}), ...(state.clientProfile ? a.update : a.create) }; return state.clientProfile; },
      update: async (a: any) => { state.clientProfile = { ...state.clientProfile, ...a.data }; return state.clientProfile; },
      findUnique: async () => state.clientProfile
    }
  };
  const db: any = { ...tx, $transaction: async (fn: any) => fn(tx) };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  return state;
}
async function load(t: TestContext) {
  const state = createDb(t);
  const { profileService } = await import(`./profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { profileService, state };
}
const parse = (body: any) => { const r = updateProfileSchema.safeParse(body); assert.ok(r.success, JSON.stringify((r as any).error?.issues)); return r.data; };

test('bio saves and comes back from getProfile', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateProfile('c1', 'CLIENT', parse({ bio: 'عميل يبحث عن مطورين' }));
  assert.equal(state.clientProfile.bio, 'عميل يبحث عن مطورين');
  const me = await profileService.getProfile('c1');
  assert.equal(me.currentProfileData.bio, 'عميل يبحث عن مطورين');
});

test('interests are saved (trimmed, de-duplicated) and survive a reload', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateProfile('c1', 'CLIENT', parse({ interests: [' تصميم ', 'برمجة', 'تصميم'] }));
  assert.deepEqual(state.clientProfile.interests, ['تصميم', 'برمجة']);
  assert.deepEqual((await profileService.getProfile('c1')).currentProfileData.interests, ['تصميم', 'برمجة']);
  await profileService.updateProfile('c1', 'CLIENT', parse({ interests: [] }));
  assert.deepEqual(state.clientProfile.interests, [], 'an empty list clears them');
});

test('personal links save, update, and an empty string clears them (stored as null)', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateProfile('c1', 'CLIENT', parse({ portfolioUrl: 'https://p.example.com', linkedinUrl: 'https://linkedin.com/in/nora', personalWebsiteUrl: 'https://nora.example.com' }));
  assert.deepEqual([state.clientProfile.portfolioUrl, state.clientProfile.linkedinUrl, state.clientProfile.personalWebsiteUrl], ['https://p.example.com', 'https://linkedin.com/in/nora', 'https://nora.example.com']);
  await profileService.updateProfile('c1', 'CLIENT', parse({ portfolioUrl: 'https://p2.example.com', linkedinUrl: '' }));
  assert.equal(state.clientProfile.portfolioUrl, 'https://p2.example.com');
  assert.equal(state.clientProfile.linkedinUrl, null);
  assert.equal(state.clientProfile.personalWebsiteUrl, 'https://nora.example.com', 'fields not sent are kept');
  const me = (await profileService.getProfile('c1')).currentProfileData;
  assert.equal(me.portfolioUrl, 'https://p2.example.com');
});

test('display preferences (language / timezone) save', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateProfile('c1', 'CLIENT', parse({ interfaceLanguage: 'English', timezone: '(GMT+4) توقيت دبي' }));
  assert.equal(state.clientProfile.interfaceLanguage, 'English');
  assert.equal(state.clientProfile.timezone, '(GMT+4) توقيت دبي');
});

test('validation: bad URLs, too many / too long interests and an unknown language are rejected (400 from the DTO), nothing is written', async (t) => {
  const { state } = await load(t);
  for (const bad of [{ portfolioUrl: 'not a url' }, { linkedinUrl: 'linkedin.com/in/x' }, { personalWebsiteUrl: 'ftp//x' }, { interests: Array.from({ length: 21 }, (_, i) => `i${i}`) }, { interests: ['x'.repeat(41)] }, { interfaceLanguage: 'Klingon' }]) {
    assert.equal(updateProfileSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(state.clientProfile.interests, []);
});

test('a client body can never write provider-only fields onto the client row (no unknown-column crash)', async (t) => {
  const { profileService, state } = await load(t);
  await profileService.updateProfile('c1', 'CLIENT', { skills: ['x'], hourlyRate: 50, headline: 'h', githubUrl: 'https://g.example.com', paypalPayoutEmail: 'a@b.co', bio: 'ok' } as any);
  for (const k of ['skills', 'hourlyRate', 'headline', 'githubUrl', 'paypalPayoutEmail']) assert.equal(k in state.clientProfile, false, k);
  assert.equal(state.clientProfile.bio, 'ok');
});

test('a body with only provider-only fields writes nothing and does not fail', async (t) => {
  const { profileService, state } = await load(t);
  const before = JSON.stringify(state.clientProfile);
  const out = await profileService.updateProfile('c1', 'CLIENT', { skills: ['x'] } as any);
  assert.equal(JSON.stringify(state.clientProfile), before);
  assert.ok(out);
});
