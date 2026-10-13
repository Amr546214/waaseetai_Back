import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

async function load(t: TestContext, preferences: unknown, hasProfile = true) {
  const mails: any[] = []; const pushes: any[] = [];
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (o: any) => { mails.push(o); return {}; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
  t.mock.module('../socket', { namedExports: { getIO: () => ({ to() { return this; }, emit: (_e: string, d: any) => pushes.push(d) }) } });
  const stored = { id: 'n1', userId: 'u1', title: 'عرض جديد', message: 'وصلك عرض', category: 'ALL', type: 'GENERAL', actionUrl: '/provider-overview/offers', actionText: null, metadata: null, isRead: false, createdAt: new Date(), updatedAt: new Date() };
  t.mock.module('../config/db', { namedExports: { prisma: {
    notification: { create: async () => stored },
    providerProfile: { findUnique: async () => (hasProfile ? { preferences, user: { email: 'p@example.com', firstName: 'سارة' } } : null) },
  } } });
  const mod = await import(`./notification.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { ...mod, mails, pushes };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('resolveNotificationChannels: nothing saved = push on, email off', async t => {
  const { resolveNotificationChannels: r } = await load(t, null);
  assert.deepEqual(r(null), { push: true, email: false });
  assert.deepEqual(r({}), { push: true, email: false });
  assert.deepEqual(r({ notifChannels: ['email'] }), { push: false, email: true });
  assert.deepEqual(r({ notifChannels: ['push', 'email'] }), { push: true, email: true });
  assert.deepEqual(r({ notifChannels: [] }), { push: false, email: false });
});

test('email disabled: no mail is sent, the real-time push still goes', async t => {
  const { notificationService, mails, pushes } = await load(t, { notifChannels: ['push'] });
  await notificationService.createAndEmit({ userId: 'u1', title: 'ت', message: 'م' });
  await settle();
  assert.equal(mails.length, 0);
  assert.equal(pushes.length, 1);
});

test('push disabled: the notification is stored and returned but not pushed in real time; the mail goes', async t => {
  const { notificationService, mails, pushes } = await load(t, { notifChannels: ['email'] });
  const dto = await notificationService.createAndEmit({ userId: 'u1', title: 'ت', message: 'م' });
  await settle();
  assert.equal(dto.id, 'n1');
  assert.equal(pushes.length, 0);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'p@example.com');
});

test('both channels disabled: stored only — no push, no mail', async t => {
  const { notificationService, mails, pushes } = await load(t, { notifChannels: [] });
  const dto = await notificationService.createAndEmit({ userId: 'u1', title: 'ت', message: 'م' });
  await settle();
  assert.equal(dto.id, 'n1');
  assert.equal(mails.length + pushes.length, 0);
});

test('not a provider / no preferences: behaviour is unchanged (push, no mail)', async t => {
  const { notificationService, mails, pushes } = await load(t, undefined, false);
  await notificationService.createAndEmit({ userId: 'u1', title: 'ت', message: 'م' });
  await settle();
  assert.equal(pushes.length, 1);
  assert.equal(mails.length, 0);
});
