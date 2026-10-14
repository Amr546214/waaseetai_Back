import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

let store: { settings: any } | null;
let current: any;
const delegatingPrisma = new Proxy({}, { get: (_t, key) => current[key as string] });

async function load(t: TestContext, initial: any = null) {
  store = initial === null ? null : { settings: initial };
  current = { notificationPreference: {
    findUnique: async () => store,
    upsert: async ({ create, update }: any) => { store = store ? { settings: update.settings } : { settings: create.settings }; return store; }
  } };
  t.mock.module('../config/db', { namedExports: { prisma: delegatingPrisma } });
  return (await import(`./marketer-settings.service.ts?f=${Date.now()}-${Math.random()}`)).marketerSettingsService;
}

test('nothing saved: in-app on, e-mail off, per-event on, Arabic, no timezone (the browser zone)', async t => {
  const svc = await load(t);
  assert.deepEqual(await svc.get('u1'), { inApp: true, email: false, newReferral: true, newCommission: true, communicationLanguage: 'ar', timezone: null });
});

test('save then reload: every setting persists', async t => {
  const svc = await load(t);
  const saved = await svc.update('u1', { email: true, inApp: false, newReferral: false, communicationLanguage: 'en', timezone: 'Asia/Dubai' });
  assert.deepEqual(saved, { inApp: false, email: true, newReferral: false, newCommission: true, communicationLanguage: 'en', timezone: 'Asia/Dubai' });
  assert.deepEqual(await svc.get('u1'), saved);
  assert.equal(store!.settings.channel_in_app, false);
  assert.equal(store!.settings.channel_email, true);
  assert.equal(store!.settings.marketer_communication_language, 'en');
  assert.equal(store!.settings.marketer_timezone, 'Asia/Dubai');
});

test('a save merges: another role\'s keys and untouched marketer keys survive', async t => {
  const svc = await load(t, { newOffer: false, orders_offers_new: true, marketer_new_commission: false });
  await svc.update('u1', { timezone: 'Asia/Riyadh' });
  assert.equal(store!.settings.newOffer, false);
  assert.equal(store!.settings.orders_offers_new, true);
  assert.equal(store!.settings.marketer_new_commission, false);
  assert.equal(store!.settings.marketer_timezone, 'Asia/Riyadh');
});

test('a saved timezone outside the supported list is ignored on read (never reaches the date formatter)', async t => {
  const svc = await load(t, { marketer_timezone: 'Mars/Olympus' });
  assert.equal((await svc.get('u1')).timezone, null);
});

test('validation: unknown language / timezone / non-boolean switch / empty body / unknown key are rejected', async () => {
  const { updateMarketerSettingsSchema: schema } = await import('../dtos/marketer-settings.dto');
  assert.equal(schema.safeParse({ communicationLanguage: 'fr' }).success, false);
  assert.equal(schema.safeParse({ timezone: 'Mars/Olympus' }).success, false);
  assert.equal(schema.safeParse({ email: 'yes' }).success, false);
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ marketer_tier_upgrade: true }).success, false);
  assert.equal(schema.safeParse({ communicationLanguage: 'ar', timezone: 'Asia/Kuwait', email: true }).success, true);
});

test('the shared notification-preferences endpoint accepts the short text values the marketer page stores (a page that sends back what it loaded never gets a 400)', async () => {
  const { updateNotificationPreferencesSchema: schema } = await import('../dtos/notification-preferences.dto');
  assert.equal(schema.safeParse({ settings: { channel_email: true, marketer_timezone: 'Asia/Dubai' } }).success, true);
  assert.equal(schema.safeParse({ settings: { x: { a: 1 } } }).success, false);
});

test('timezone null removes the saved value (back to the device zone) and leaves every other key', async t => {
  const svc = await load(t, { marketer_timezone: 'Asia/Dubai', newOffer: true });
  const saved = await svc.update('u1', { timezone: null });
  assert.equal(saved.timezone, null);
  assert.equal('marketer_timezone' in store!.settings, false);
  assert.equal(store!.settings.newOffer, true);
});
