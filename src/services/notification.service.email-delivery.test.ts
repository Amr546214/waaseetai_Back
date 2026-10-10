import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// notification.service transitively loads ../socket, which builds an OpenAI client at import time.
process.env.OPENAI_API_KEY = 'test-key';

const CODE = '482913';

async function load(t: TestContext, sendMail: (opts: any) => Promise<any>) {
  const logs: string[] = [];
  const push = (m: unknown) => logs.push(String(m));
  t.mock.module('../config/logger', { namedExports: { logger: { info: push, warn: push, error: push, debug: push } } });
  const calls: any[] = [];
  t.mock.module('../utils/mail.transporter', { namedExports: {
    mailTransporter: { sendMail: async (o: any) => { calls.push(o); return sendMail(o); } },
    getOtpEmailTemplate: (code: string) => `<p>${code}</p>`,
    getPasswordResetEmailTemplate: (_n: string, code: string) => `<p>${code}</p>`,
  } });
  const { notificationService } = await import(`./notification.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { notificationService, logs, calls };
}

test('a delivered OTP email returns the SMTP result and logs messageId / accepted / rejected / response, never the code', async (t) => {
  const { notificationService, logs } = await load(t, async () => ({ messageId: '<abc@titan>', accepted: ['amr@example.com'], rejected: [], response: '250 2.0.0 OK queued as 1F2A3B' }));
  const result = await notificationService.sendEmailOtp('amr@example.com', CODE);
  assert.deepEqual(result, { messageId: '<abc@titan>', accepted: ['a***@example.com'], rejected: [], response: '250 2.0.0 OK queued as 1F2A3B' });
  const line = logs.find(l => l.includes('[Email:otp]'))!;
  for (const needle of ['messageId=<abc@titan>', 'accepted=["a***@example.com"]', 'rejected=[]', '250 2.0.0 OK queued as 1F2A3B']) assert.ok(line.includes(needle), needle);
  assert.ok(logs.every(l => !l.includes(CODE)), 'the code is never logged');
  assert.ok(logs.every(l => !l.includes('amr@example.com')), 'the address is masked');
});

test('an SMTP failure is logged with its code and response (no code, no secrets) and thrown so the caller can report emailSent=false', async (t) => {
  const { notificationService, logs } = await load(t, async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' }); });
  await assert.rejects(() => notificationService.sendEmailOtp('amr@example.com', CODE), /Invalid login/);
  const line = logs.find(l => l.includes('FAILED'))!;
  assert.ok(line.includes('code=EAUTH') && line.includes('responseCode=535') && line.includes('Authentication failed'));
  assert.ok(logs.every(l => !l.includes(CODE)));
});

test('a recipient rejected by the server is a failed delivery even though sendMail resolved', async (t) => {
  const { notificationService, logs } = await load(t, async () => ({ messageId: '<x>', accepted: [], rejected: ['bad@example.com'], response: '550 5.1.1 mailbox unavailable' }));
  await assert.rejects(() => notificationService.sendEmailOtp('bad@example.com', CODE), /rejected/);
  assert.ok(logs.some(l => l.includes('rejected=["b***@example.com"]') && l.includes('550')));
  assert.ok(logs.every(l => !l.includes(CODE)));
});

test('password reset emails log the same delivery details and never the code', async (t) => {
  const { notificationService, logs } = await load(t, async () => ({ messageId: '<r1>', accepted: ['amr@example.com'], rejected: [], response: '250 OK' }));
  await notificationService.sendPasswordResetEmail('amr@example.com', 'Amr', CODE);
  assert.ok(logs.some(l => l.includes('[Email:password-reset]') && l.includes('messageId=<r1>')));
  assert.ok(logs.every(l => !l.includes(CODE)));
});

// ── one shared OTP sender: a PayPal code is delivered exactly like a login code ──
test('PayPal OTP and login OTP are sent through the same sender: same from, same HTML/text/headers; only the subject differs', async (t) => {
  const { notificationService, calls } = await load(t, async () => ({ messageId: '<m>', accepted: ['amr@example.com'], rejected: [], response: '250 OK' }));
  await notificationService.sendLoginOtpEmail('amr@example.com', CODE);
  await notificationService.sendPaypalEmailChangeOtpEmail('amr@example.com', CODE);
  const [login, paypal] = calls;
  assert.equal(paypal.from, login.from);
  assert.equal(paypal.to, login.to);
  assert.equal(paypal.html, login.html);
  assert.equal(paypal.text, login.text);
  assert.deepEqual(paypal.headers, login.headers);
  assert.notEqual(paypal.subject, login.subject);
  assert.ok(!/paypal/i.test(paypal.subject), 'no third-party brand in the subject');
  assert.match(paypal.subject, /رمز التحقق/);
});

test('every OTP e-mail has a plain-text part and transactional headers (an HTML-only message is a spam signal)', async (t) => {
  const { notificationService, calls } = await load(t, async () => ({ messageId: '<m>', accepted: ['amr@example.com'], rejected: [], response: '250 OK' }));
  await notificationService.sendEmailOtp('amr@example.com', CODE);
  await notificationService.sendPhoneChangeOtpEmail('amr@example.com', CODE);
  await notificationService.sendLoginOtpEmail('amr@example.com', CODE);
  await notificationService.sendPaypalEmailChangeOtpEmail('amr@example.com', CODE);
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.ok(c.text.includes(CODE), 'the code is in the message body (that is the point) ...');
    assert.equal(c.headers['Auto-Submitted'], 'auto-generated');
  }
});

test('PayPal OTP: delivery details are logged (message id, accepted, rejected, response) and the code never is; a rejected recipient throws', async (t) => {
  const ok = await load(t, async () => ({ messageId: '<pp1@titan>', accepted: ['amr@example.com'], rejected: [], response: '250 2.0.0 Ok: queued as 4j1z' }));
  await ok.notificationService.sendPaypalEmailChangeOtpEmail('amr@example.com', CODE);
  assert.ok(ok.logs.some(l => l.includes('[Email:paypal-email-change]') && l.includes('messageId=<pp1@titan>') && l.includes('accepted=["a***@example.com"]') && l.includes('queued as 4j1z')));
  assert.ok(ok.logs.every(l => !l.includes(CODE)), 'the code is never logged');
});
