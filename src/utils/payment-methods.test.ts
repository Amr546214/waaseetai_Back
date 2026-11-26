import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPaymentDetails, decryptPaymentDetails, isRajhiIban, maskedEmail, paymentRole, paypalConnectConfig, rajhiMethodSchema } from './payment-methods';

export function syntheticRajhiIban(account = '000000000000000001') {
  const base = `80${account}`;
  let remainder = 0;
  for (const c of `${base}281000`) remainder = (remainder * 10 + Number(c)) % 97;
  return `SA${String(98 - remainder).padStart(2, '0')}${base}`;
}
test('Saudi Al Rajhi IBAN accepts formatted input; rejects checksum, other bank, non-SA and oversized input', () => {
  const iban = syntheticRajhiIban();
  assert.equal(isRajhiIban(iban), true);
  assert.equal(isRajhiIban(iban.match(/.{1,4}/g)!.join(' ')), true);
  assert.equal(isRajhiIban(iban.slice(0, -1) + '2'), false);
  assert.equal(isRajhiIban('SA2810000011100000461309'), false);
  assert.equal(isRajhiIban('GB82WEST12345698765432'), false);
  assert.equal(rajhiMethodSchema.safeParse({ accountHolder: 'Valid Name', iban, verified: true }).success, false);
});
test('payment encryption is randomized, authenticated and bound to the owner, role, rail and environment', () => {
  process.env.PAYMENT_METHODS_ENCRYPTION_KEY = '1'.repeat(64);
  const data = { iban: syntheticRajhiIban(), accountHolder: 'Synthetic Owner' }, context = 'owner:PROVIDER:ALRAJHI:sandbox';
  const a = encryptPaymentDetails(data, context), b = encryptPaymentDetails(data, context);
  assert.notEqual(a, b); assert.ok(!a.includes(data.iban));
  assert.deepEqual(decryptPaymentDetails(a, context), data);
  for (const wrong of ['other:PROVIDER:ALRAJHI:sandbox', 'owner:CLIENT:ALRAJHI:sandbox', 'owner:PROVIDER:ALRAJHI:live']) assert.throws(() => decryptPaymentDetails(a, wrong));
  assert.throws(() => decryptPaymentDetails(a.slice(0, -4), context));
  delete process.env.PAYMENT_METHODS_ENCRYPTION_KEY;
  assert.throws(() => encryptPaymentDetails(data, context), (e: any) => e.statusCode === 503);
});
test('masks email and denies administrative roles rather than inferring a financial profile', () => {
  assert.equal(maskedEmail('owner@example.com'), 'o***@e***.com');
  assert.equal(paymentRole('AFFILIATE'), 'AFFILIATE');
  assert.throws(() => paymentRole('ADMIN')); assert.throws(() => paymentRole(undefined));
});
test('PayPal connect has dedicated credentials and explicit live approval; rejects mismatched mode/return host', () => {
  process.env.PAYMENT_METHODS_ENCRYPTION_KEY = '2'.repeat(64);
  process.env.PAYPAL_CLIENT_ID = 'existing-checkout-id';
  process.env.PAYPAL_CLIENT_SECRET = 'existing-checkout-secret';
  assert.equal(paypalConnectConfig(), null);
  Object.assign(process.env, { PAYMENT_METHODS_ENV: 'sandbox', PAYPAL_CONNECT_MODE: 'sandbox', PAYPAL_CONNECT_CLIENT_ID: 'id', PAYPAL_CONNECT_CLIENT_SECRET: 'secret', PAYPAL_CONNECT_RETURN_URL: 'https://dev.waseetai.com/payment-methods/paypal-return' });
  assert.equal(paypalConnectConfig()?.mode, 'sandbox');
  process.env.PAYPAL_CONNECT_RETURN_URL = 'https://attacker.example/payment-methods/paypal-return'; assert.equal(paypalConnectConfig(), null);
  Object.assign(process.env, { PAYMENT_METHODS_ENV: 'live', PAYPAL_CONNECT_MODE: 'live', PAYPAL_CONNECT_RETURN_URL: 'https://waseetai.com/payment-methods/paypal-return' });
  delete process.env.PAYPAL_CONNECT_LIVE_APPROVED; assert.equal(paypalConnectConfig(), null);
  process.env.PAYPAL_CONNECT_LIVE_APPROVED = 'true'; assert.equal(paypalConnectConfig()?.mode, 'live');
  process.env.PAYPAL_CONNECT_RETURN_URL += '?redirect=elsewhere'; assert.equal(paypalConnectConfig(), null);
});
