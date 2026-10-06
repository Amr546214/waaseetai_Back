import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText } from './sanitize-text';
import { registerSchema } from '../routes/auth/auth.schema';
import { updateProfileSchema } from '../dtos/profile.dto';
import { updateBasicsSchema } from '../dtos/profile-tab.dto';
import { profileSetupSchema } from '../dtos/profile-setup.dto';
import { CreateIdentityRequestSchema } from '../dtos/profile-requests.dto';
import { updateMarketingInfoSchema, addChannelSchema } from '../dtos/marketer-profile.dto';

// AUD-FND-000025 — free-text profile fields must be stored as plain text, never as markup.
const XSS = '<img src=x onerror=alert(1)>';

test('sanitizeText strips tags (closed, unclosed, nested) and control characters', () => {
	assert.equal(sanitizeText(`${XSS}Amr`), 'Amr');
	assert.equal(sanitizeText('<script>alert(1)</script>Sara'), 'alert(1)Sara');
	assert.equal(sanitizeText('<img src=x onerror=alert(1)'), '');
	assert.equal(sanitizeText('<<b>b>Text'), 'Text');
	assert.equal(sanitizeText('a\u0000b\u0007c'), 'abc');
});

test('sanitizeText leaves ordinary Arabic and punctuation untouched', () => {
	for (const ok of ['محمد أحمد العتيبي', 'مطوّر واجهات — خبرة 5 سنوات', 'السعر < 500 و> 100', "O'Brien-Smith", 'نبذة\nبسطرين']) assert.equal(sanitizeText(ok), ok);
});

const validRegister = { accountType: 'CLIENT_INDIVIDUAL', firstName: 'Amr', lastName: 'Okasha', email: 'a@example.com', phoneNumber: '500000000', password: 'Password1', agreedToTerms: true };

test('registration names are sanitized before validation', () => {
	const r: any = registerSchema.safeParse({ body: { ...validRegister, firstName: `${XSS}Amr`, lastName: '<b>Okasha</b>' } });
	assert.equal(r.success, true);
	assert.equal(r.data.body.firstName, 'Amr');
	assert.equal(r.data.body.lastName, 'Okasha');
});

test('a name that is only markup is rejected (it is empty text), not stored', () => {
	assert.equal(registerSchema.safeParse({ body: { ...validRegister, firstName: '<b></b>' } }).success, false);
});

test('PUT /profiles/update: names and bio are sanitized', () => {
	const r: any = updateProfileSchema.safeParse({ firstName: `${XSS}Amr`, lastName: 'Okasha<script>x</script>', bio: `نبذة ${XSS} حقيقية` });
	assert.equal(r.success, true);
	assert.deepEqual([r.data.firstName, r.data.lastName, r.data.bio], ['Amr', 'Okashax', 'نبذة  حقيقية']);
});

test('profile tab (basics) names are sanitized', () => {
	const r: any = updateBasicsSchema.safeParse({ firstName: `${XSS}Amr`, lastName: 'Okasha' });
	assert.equal(r.success, true);
	assert.equal(r.data.firstName, 'Amr');
});

test('profile setup bio is sanitized', () => {
	const r: any = profileSetupSchema.safeParse({ bio: `hello ${XSS}` });
	assert.equal(r.success, true);
	assert.equal(r.data.bio, 'hello ');
});

test('identity change request names are sanitized', () => {
	const r: any = CreateIdentityRequestSchema.safeParse({ firstName: `${XSS}Amr` });
	assert.equal(r.success, true);
	assert.equal(r.data.firstName, 'Amr');
});

test('marketer bio and marketing channel handle are sanitized', () => {
	const bio: any = updateMarketingInfoSchema.safeParse({ bio: `وصف ${XSS} تسويقي` });
	assert.equal(bio.success, true);
	assert.equal(bio.data.bio, 'وصف  تسويقي');
	const ch: any = addChannelSchema.safeParse({ platform: 'INSTAGRAM', handle: `@user${XSS}` });
	assert.equal(ch.success, true);
	assert.equal(ch.data.handle, '@user');
});
