import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtpSendThrottle, formatWaitArabic, otpThrottleMessage } from './otp-send-throttle';

const T0 = 1_700_000_000_000;

test('first send is allowed; a second send within 60 s is refused with the remaining seconds', () => {
  const t = new OtpSendThrottle();
  assert.equal(t.consume('a@b.co', '1.1.1.1', T0).allowed, true);
  const r = t.consume('a@b.co', '1.1.1.1', T0 + 20_000);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'interval');
  assert.equal(r.retryAfterSeconds, 40);
  assert.equal(t.consume('a@b.co', '1.1.1.1', T0 + 60_000).allowed, true);
});

test('a refused attempt does not extend the wait (asking again early is harmless)', () => {
  const t = new OtpSendThrottle();
  t.consume('a@b.co', 'ip', T0);
  t.consume('a@b.co', 'ip', T0 + 10_000);
  t.consume('a@b.co', 'ip', T0 + 30_000);
  assert.equal(t.consume('a@b.co', 'ip', T0 + 60_000).allowed, true);
});

test('5 sends per hour per recipient; the 6th is refused until the oldest leaves the window', () => {
  const t = new OtpSendThrottle();
  for (let i = 0; i < 5; i++) assert.equal(t.consume('a@b.co', 'ip', T0 + i * 61_000).allowed, true, `send ${i + 1}`);
  const r = t.consume('a@b.co', 'ip', T0 + 5 * 61_000);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'recipient-hour');
  assert.equal(r.retryAfterSeconds, Math.ceil((3_600_000 - 5 * 61_000) / 1000));
  assert.equal(t.consume('a@b.co', 'ip', T0 + 3_600_000 + 1_000).allowed, true);
});

test('30 sends per hour per IP across different recipients; the 31st is refused', () => {
  const t = new OtpSendThrottle();
  for (let i = 0; i < 30; i++) assert.equal(t.consume(`user${i}@b.co`, '9.9.9.9', T0 + i).allowed, true, `ip send ${i + 1}`);
  const r = t.consume('user31@b.co', '9.9.9.9', T0 + 31);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ip-hour');
  assert.equal(t.consume('user31@b.co', '8.8.8.8', T0 + 31).allowed, true); // another IP is unaffected
});

test('recipients are independent and case/whitespace-insensitive', () => {
  const t = new OtpSendThrottle();
  assert.equal(t.consume('A@B.co ', 'ip', T0).allowed, true);
  assert.equal(t.consume('a@b.co', 'ip', T0 + 1_000).allowed, false);
  assert.equal(t.consume('other@b.co', 'ip', T0 + 1_000).allowed, true);
});

test('Arabic messages carry the wait, and the wait formatter is Arabic', () => {
  assert.equal(formatWaitArabic(30), '30 ثانية');
  assert.equal(formatWaitArabic(60), 'دقيقة');
  assert.equal(formatWaitArabic(120), 'دقيقتين');
  assert.equal(formatWaitArabic(600), '10 دقائق');
  assert.equal(formatWaitArabic(3600), 'ساعة');
  for (const reason of ['interval', 'recipient-hour', 'ip-hour'] as const) {
    const m = otpThrottleMessage(reason, 120);
    assert.match(m, /[؀-ۿ]/);
    assert.match(m, /دقيقتين/);
    assert.doesNotMatch(m, /[A-Za-z]{4,}/);
  }
});
