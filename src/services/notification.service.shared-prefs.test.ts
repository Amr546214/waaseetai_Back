import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// A client (no provider channels chosen) is delivered through the shared notification preferences saved from the profile / settings pages:
// channel_in_app (real-time push) and channel_email (e-mail copy). Nothing saved = push on, e-mail off. A provider's explicit channels still win.

async function load(t: TestContext, o: { settings?: Record<string, boolean> | null; providerPrefs?: unknown; hasProvider?: boolean; prefsThrow?: boolean }) {
  const mails: any[] = []; const pushes: any[] = [];
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (x: any) => { mails.push(x); return {}; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
  t.mock.module('../socket', { namedExports: { getIO: () => ({ to() { return this; }, emit: (_e: string, d: any) => pushes.push(d) }) } });
  const stored = { id: 'n1', userId: 'u1', title: 'ت', message: 'م', category: 'ALL', type: 'GENERAL', actionUrl: null, actionText: null, metadata: null, isRead: false, createdAt: new Date(), updatedAt: new Date() };
  t.mock.module('../config/db', { namedExports: { prisma: {
    notification: { create: async () => stored },
    providerProfile: { findUnique: async () => (o.hasProvider ? { preferences: o.providerPrefs, user: { email: 'prov@example.com', firstName: 'م' } } : null) },
    notificationPreference: { findUnique: async () => { if (o.prefsThrow) throw new Error('db'); return o.settings === undefined || o.settings === null ? null : { settings: o.settings }; } },
    user: { findUnique: async () => ({ email: 'client@example.com', firstName: 'ع' }) },
  } } });
  const mod = await import(`./notification.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: mod.notificationService, mails, pushes };
}
const settle = () => new Promise(r => setTimeout(r, 20));
const send = async (c: any) => { await c.service.createAndEmit({ userId: 'u1', title: 'ت', message: 'م' }); await settle(); };

test('client with nothing saved: real-time push, no e-mail', async t => {
  const c = await load(t, { settings: null }); await send(c);
  assert.equal(c.pushes.length, 1); assert.equal(c.mails.length, 0);
});

test('client turns e-mail on: a mail copy goes to the account e-mail, push stays', async t => {
  const c = await load(t, { settings: { channel_email: true } }); await send(c);
  assert.equal(c.pushes.length, 1); assert.equal(c.mails.length, 1); assert.equal(c.mails[0].to, 'client@example.com');
});

test('client turns the in-app channel off: stored only (no push), no mail unless e-mail is on', async t => {
  const c = await load(t, { settings: { channel_in_app: false } }); await send(c);
  assert.equal(c.pushes.length, 0); assert.equal(c.mails.length, 0);
});

test('client e-mail off explicitly: no mail', async t => {
  const c = await load(t, { settings: { channel_email: false, channel_in_app: true } }); await send(c);
  assert.equal(c.mails.length, 0); assert.equal(c.pushes.length, 1);
});

test('a provider\'s explicit channels win over the shared preferences', async t => {
  const c = await load(t, { hasProvider: true, providerPrefs: { notifChannels: ['email'] }, settings: { channel_in_app: true, channel_email: false } }); await send(c);
  assert.equal(c.pushes.length, 0); assert.equal(c.mails.length, 1); assert.equal(c.mails[0].to, 'prov@example.com');
});

test('a failing preference read falls back to the default (push, no mail)', async t => {
  const c = await load(t, { prefsThrow: true }); await send(c);
  assert.equal(c.pushes.length, 1); assert.equal(c.mails.length, 0);
});
