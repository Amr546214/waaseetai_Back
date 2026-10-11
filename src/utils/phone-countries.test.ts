import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, canonicalStoredPhone, isValidNationalNumber, callingDigits } from './phone-countries';

test('normalizePhone: the "+" form decides the country and stores the local number (+20 and +966)', () => {
  assert.deepEqual(normalizePhone('+201025073026'), { countryCode: '+20', nationalNumber: '1025073026' });
  assert.deepEqual(normalizePhone('+20 102 507 3026', '+966'), { countryCode: '+20', nationalNumber: '1025073026' });
  assert.deepEqual(normalizePhone('+966501234567'), { countryCode: '+966', nationalNumber: '501234567' });
});

test('normalizePhone: digits pasted WITHOUT the "+" are split when no country was chosen, or when they carry the chosen country\'s code', () => {
  assert.deepEqual(normalizePhone('201025073026'), { countryCode: '+20', nationalNumber: '1025073026' });
  assert.deepEqual(normalizePhone('201025073026', '+20'), { countryCode: '+20', nationalNumber: '1025073026' });
  assert.deepEqual(normalizePhone('966501234567', '+966'), { countryCode: '+966', nationalNumber: '501234567' });
});

test('normalizePhone: the local number of the chosen country, with or without the trunk zero', () => {
  assert.deepEqual(normalizePhone('01025073026', '+20'), { countryCode: '+20', nationalNumber: '1025073026' });
  assert.deepEqual(normalizePhone('1025073026', '+20'), { countryCode: '+20', nationalNumber: '1025073026' });
  assert.deepEqual(normalizePhone('0501234567', '+966'), { countryCode: '+966', nationalNumber: '501234567' });
});

test('normalizePhone: a mismatched pair is refused, never stored: an Egyptian number with +966, a Saudi number with +20', () => {
  assert.throws(() => normalizePhone('1025073026', '+966'), /INVALID_PHONE/);
  assert.throws(() => normalizePhone('01025073026', '+966'), /INVALID_PHONE/);
  assert.throws(() => normalizePhone('501234567', '+20'), /INVALID_PHONE/);
  assert.throws(() => normalizePhone('abc', '+966'), /INVALID_PHONE/);
  assert.throws(() => normalizePhone('', '+966'), /INVALID_PHONE/);
  assert.throws(() => normalizePhone('+9665', '+966'), /INVALID_PHONE/);
});

test('isValidNationalNumber / callingDigits', () => {
  assert.equal(isValidNationalNumber('+20', '1025073026'), true);
  assert.equal(isValidNationalNumber('+966', '1025073026'), false);
  assert.equal(isValidNationalNumber('+966', '501234567'), true);
  assert.equal(callingDigits(null), '966');
  assert.equal(callingDigits('+20'), '20');
});

test('canonicalStoredPhone: a consistent row is shown as is; an Egyptian number saved next to +966 is repaired from its digits (never shown as Saudi)', () => {
  assert.deepEqual(canonicalStoredPhone('+966', '501234567'), { countryCode: '+966', nationalNumber: '501234567', display: '+966 501234567', consistent: true });
  assert.deepEqual(canonicalStoredPhone('+20', '1025073026'), { countryCode: '+20', nationalNumber: '1025073026', display: '+20 1025073026', consistent: true });
  const bad = canonicalStoredPhone('+966', '201025073026');
  assert.deepEqual([bad.countryCode, bad.nationalNumber, bad.display, bad.consistent], ['+20', '1025073026', '+20 1025073026', false]);
});

test('canonicalStoredPhone: legacy shapes (leading zero, a full +CC number in phoneNumber, a missing code) display correctly and are flagged for re-saving', () => {
  assert.equal(canonicalStoredPhone('+966', '0501234567').display, '+966 501234567');
  assert.equal(canonicalStoredPhone('+966', '0501234567').consistent, false);
  assert.equal(canonicalStoredPhone('+966', '+966501234567').display, '+966 501234567');
  assert.equal(canonicalStoredPhone(null, '501234567').display, '+966 501234567');
  assert.equal(canonicalStoredPhone('+966', '').display, '');
  assert.equal(canonicalStoredPhone('+966', '123').consistent, false); // nothing can repair it: shown as stored, flagged
});
