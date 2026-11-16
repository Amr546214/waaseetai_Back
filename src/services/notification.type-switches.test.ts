import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { preferenceGroupOf, isMutedBySettings } from './notification-preference-groups';

process.env.OPENAI_API_KEY = 'test-key';

// Per-type switches: a type the user turned OFF is not stored, pushed or mailed; everything else (and anything not switchable) still arrives.

async function load(t: TestContext, settings: Record<string, boolean> | null, type: string) {
  const pushes: any[] = []; const deleted: string[] = []; const mails: any[] = [];
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (x: any) => { mails.push(x); return {}; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
  t.mock.module('../socket', { namedExports: { getIO: () => ({ to() { return this; }, emit: (_e: string, d: any) => pushes.push(d) }) } });
  const stored = { id: 'n1', userId: 'u1', title: 'ت', message: 'م', category: 'ALL', type, actionUrl: null, actionText: null, metadata: null, isRead: false, createdAt: new Date(), updatedAt: new Date() };
  t.mock.module('../config/db', { namedExports: { prisma: {
    notification: { create: async () => stored, deleteMany: async ({ where }: any) => { deleted.push(where.id); return { count: 1 }; } },
    providerProfile: { findUnique: async () => null },
    notificationPreference: { findUnique: async () => (settings ? { settings } : null) },
    user: { findUnique: async () => ({ email: 'c@example.com', firstName: 'ع' }) },
  } } });
  const mod = await import(`./notification.service.ts?fixture=${Date.now()}-${Math.random()}`);
  await mod.notificationService.createAndEmit({ userId: 'u1', title: 'ت', message: 'م', type });
  await new Promise(r => setTimeout(r, 20));
  return { pushes, deleted, mails };
}

test('groups: types map to their switch, withdrawals by prefix, security/disputes are not switchable', () => {
  assert.equal(preferenceGroupOf('NEW_PROPOSAL'), 'newOffer');
  assert.equal(preferenceGroupOf('CHAT'), 'newMessage');
  assert.equal(preferenceGroupOf('WITHDRAWAL_APPROVED'), 'walletActivity');
  assert.equal(preferenceGroupOf('CASHBACK_CREDITED'), 'cashback');
  for (const t of ['DISPUTE_OPENED', 'KYC_APPROVED', 'PAYPAL_EMAIL_CHANGED', 'SUPPORT_TICKET', 'GENERAL', null]) assert.equal(preferenceGroupOf(t as string), null);
  assert.equal(isMutedBySettings({ newOffer: false }, 'DISPUTE_OPENED'), false);
  assert.equal(isMutedBySettings({}, 'NEW_PROPOSAL'), false);
  assert.equal(isMutedBySettings({ newOffer: false }, 'NEW_PROPOSAL'), true);
});

test('switch OFF: the notification is removed and nothing is pushed or mailed', async t => {
  const c = await load(t, { newOffer: false, channel_email: true }, 'NEW_PROPOSAL');
  assert.deepEqual(c.deleted, ['n1']); assert.equal(c.pushes.length, 0); assert.equal(c.mails.length, 0);
});

test('switch ON: the notification is delivered as before', async t => {
  const c = await load(t, { newOffer: true }, 'NEW_PROPOSAL');
  assert.equal(c.deleted.length, 0); assert.equal(c.pushes.length, 1);
});

test('never saved: delivered as before', async t => {
  const c = await load(t, null, 'NEW_PROPOSAL');
  assert.equal(c.deleted.length, 0); assert.equal(c.pushes.length, 1);
});

test('a switch of another type does not silence this one', async t => {
  const c = await load(t, { newMessage: false }, 'NEW_PROPOSAL');
  assert.equal(c.pushes.length, 1);
});

test('a non-switchable type ignores every switch', async t => {
  const c = await load(t, { newOffer: false, requestStatus: false, newMessage: false, walletActivity: false }, 'DISPUTE_OPENED');
  assert.equal(c.pushes.length, 1); assert.equal(c.deleted.length, 0);
});
