import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// A provider's profile channels (preferences.notifChannels) win at delivery, so the settings page must read and write them, not only the shared map.

async function load(t: TestContext, notifChannels: string[] | null) {
  const updates: any[] = []; let stored: Record<string, boolean> = { newOffer: false };
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../config/db', { namedExports: { prisma: {
    providerProfile: { findUnique: async () => (notifChannels ? { preferences: { notifChannels, keep: 1 } } : null), update: async (a: any) => { updates.push(a.data.preferences); return {}; } },
    notificationPreference: { findUnique: async () => ({ settings: stored }), upsert: async ({ update }: any) => { stored = update.settings; return { settings: stored }; } },
  } } });
  const mod = await import(`./notification.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { svc: mod.notificationPreferenceService, updates };
}

test('GET shows the provider profile channels in force, next to the per-type switches', async t => {
  const { svc } = await load(t, ['email']);
  assert.deepEqual(await svc.getPreferences('u1'), { newOffer: false, channel_in_app: false, channel_email: true });
});

test('PATCH of a channel switch updates the profile channels and keeps the other keys', async t => {
  const { svc, updates } = await load(t, ['push', 'email']);
  await svc.updatePreferences('u1', { channel_in_app: false });
  assert.deepEqual(updates, [{ notifChannels: ['email'], keep: 1 }]);
});

test('a provider without explicit channels (or a client) is untouched', async t => {
  const { svc, updates } = await load(t, null);
  assert.deepEqual(await svc.getPreferences('u1'), { newOffer: false });
  await svc.updatePreferences('u1', { channel_in_app: false });
  assert.equal(updates.length, 0);
});
