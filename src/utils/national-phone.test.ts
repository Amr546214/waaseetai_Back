import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNationalPhone, displayPhone, countryDigits } from './national-phone';

test('toNationalPhone: Saudi (+966) in every typed shape becomes the same national digits', () => {
  for (const typed of ['501234567', '0501234567', '+966501234567', '+966 50 123 4567', '+966(0)501234567'.replace('(0)', '')]) {
    assert.equal(toNationalPhone(typed, '+966'), '501234567', typed);
  }
});

test('toNationalPhone: Egypt (+20) keeps its national number, strips +20 and the trunk zero', () => {
  assert.equal(toNationalPhone('01012345678', '+20'), '1012345678');
  assert.equal(toNationalPhone('+201012345678', '+20'), '1012345678');
  assert.equal(toNationalPhone('1012345678', '20'), '1012345678');
});

test('toNationalPhone: a "+" number of ANOTHER country is refused (the country is not changed through this path), garbage is refused', () => {
  assert.throws(() => toNationalPhone('+201012345678', '+966'), /INVALID_PHONE_COUNTRY/);
  assert.throws(() => toNationalPhone('+966abc', '+966'), /INVALID_PHONE/);
  assert.throws(() => toNationalPhone('12345', '+966'), /INVALID_PHONE/);
  assert.throws(() => toNationalPhone('', '+966'), /INVALID_PHONE/);
});

test('toNationalPhone: a missing stored code falls back to the platform default +966', () => {
  assert.equal(countryDigits(null), '966');
  assert.equal(toNationalPhone('+966501234567', null), '501234567');
});

test('displayPhone: one "+", one code, never doubled, legacy rows tolerated', () => {
  assert.equal(displayPhone('+966', '501234567'), '+966 501234567');
  assert.equal(displayPhone('966', '501234567'), '+966 501234567');
  assert.equal(displayPhone('+20', '1012345678'), '+20 1012345678');
  assert.equal(displayPhone('+966', '0500000000'), '+966 500000000');   // legacy local-with-zero row
  assert.equal(displayPhone('+966', '+966501234567'), '+966501234567');  // a legacy full-international row is shown as is, the code is NOT repeated
  assert.equal(displayPhone('+966', ''), '');
});

test('round trip after a save: what toNationalPhone stores is what displayPhone shows after a refresh', () => {
  const stored = toNationalPhone('+20 101 234 5678', '+20');
  assert.equal(displayPhone('+20', stored), '+20 1012345678');
});
