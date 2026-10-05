import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// notification.service.ts transitively imports ../socket, which constructs
// `new OpenAI(...)` eagerly at module load — same pattern as auth.service.test.ts.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

import { notificationService } from './notification.service';

const CODE = '482913';
const PHONE = '+966500000000';
const original = { NODE_ENV: process.env.NODE_ENV, SMS_ENABLED: process.env.SMS_ENABLED };

afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function captureConsole(t: any) {
  const lines: string[] = [];
  const push = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  t.mock.method(console, 'log', push);
  t.mock.method(console, 'warn', push);
  t.mock.method(console, 'info', push);
  return lines;
}

test('sendSmsOtp: production + SMS disabled never prints the OTP code', async (t) => {
  process.env.NODE_ENV = 'production';
  delete process.env.SMS_ENABLED;
  const lines = captureConsole(t);

  await notificationService.sendSmsOtp(PHONE, CODE);

  assert.ok(lines.length > 0, 'expected a warning that the SMS was not sent');
  assert.ok(lines.every(l => !l.includes(CODE)), 'OTP code leaked to logs in production');
});

test('sendSmsOtp: SMS disabled never logs the code, in ANY environment (no clear-text OTP in logs)', async (t) => {
  for (const env of ['development', 'production', 'test']) {
    process.env.NODE_ENV = env;
    delete process.env.SMS_ENABLED;
    const lines = captureConsole(t);

    await notificationService.sendSmsOtp(PHONE, CODE);

    assert.ok(lines.every(l => !l.includes(CODE)), env);
    assert.ok(lines.every(l => !l.includes(PHONE)), `${env}: the phone number is not logged either`);
  }
});

test('isSmsAvailable: false unless SMS is enabled AND a real provider exists (the Twilio sender is still a stub)', () => {
  delete process.env.SMS_ENABLED;
  assert.equal(notificationService.isSmsAvailable(), false);
  process.env.SMS_ENABLED = 'true'; process.env.SMS_PROVIDER = 'twilio';
  assert.equal(notificationService.isSmsAvailable(), false);
  process.env.SMS_PROVIDER = 'dev';
  assert.equal(notificationService.isSmsAvailable(), false);
});

test('sendSmsOtp: production + unknown provider does not print the code', async (t) => {
  process.env.NODE_ENV = 'production';
  process.env.SMS_ENABLED = 'true';
  delete process.env.SMS_PROVIDER;
  const lines = captureConsole(t);

  await notificationService.sendSmsOtp(PHONE, CODE);

  assert.ok(lines.every(l => !l.includes(CODE)));
});
