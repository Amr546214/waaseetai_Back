import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x';

test('IDENTITY_AUTO_CHECK is OFF by default and for any non-on value', async () => {
	const { isIdentityAutoCheckEnabled } = await import('./identity-field-check.service');
	for (const v of [undefined, '', 'off', 'false', '0', 'no', 'maybe']) assert.equal(isIdentityAutoCheckEnabled({ IDENTITY_AUTO_CHECK: v } as any), false, String(v));
	for (const v of ['on', 'ON', 'true', '1']) assert.equal(isIdentityAutoCheckEnabled({ IDENTITY_AUTO_CHECK: v } as any), true, v);
});

test('national id mask keeps first 2 + last 2 only; short or missing values are fully hidden; digits are normalised', async () => {
	const { maskNationalId, normalizeDigits } = await import('./identity-field-check.service');
	assert.equal(maskNationalId('29001011234567'), '29**********67'); assert.equal(maskNationalId('123'), '****'); assert.equal(maskNationalId(null), '****');
	assert.equal(normalizeDigits('٢٩٠٠١٠١١٢٣٤٥٦٧'), '29001011234567'); assert.equal(normalizeDigits('2900 1011-234567'), '29001011234567');
});

test('sanitizeFieldResults keeps only status + a short upper-case reason code (read text can never be stored)', async () => {
	const { sanitizeFieldResults } = await import('./identity-field-check.service');
	const ok = sanitizeFieldResults({ fullName: { status: 'MATCH', read: 'احمد' }, birthDate: { status: 'MISMATCH', reason: 'DIGIT_DIFF' }, nationalId: { status: 'COULD_NOT_VERIFY', reason: 'free text 2900' } });
	assert.deepEqual(ok, { fullName: { status: 'MATCH' }, birthDate: { status: 'MISMATCH', reason: 'DIGIT_DIFF' }, nationalId: { status: 'COULD_NOT_VERIFY' } });
	assert.equal(sanitizeFieldResults({ fullName: { status: 'MATCH' } }), null); assert.equal(sanitizeFieldResults(null), null);
});

test('structural: the check never touches KYC/onboarding state (no kycStatus write, no onboarding/approve/reject import) and the hooks are fire-and-forget', () => {
	const src = fs.readFileSync(path.join(__dirname, 'identity-field-check.service.ts'), 'utf8');
	assert.ok(!/kycStatus/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no kycStatus reference in code');
	assert.ok(!/onboarding\.service|approveOnboarding|rejectOnboarding|ProviderKyc|clientOnboarding|\.user\.update/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
	for (const f of ['../controllers/client-profile.controller.ts', '../controllers/provider-profile.controller.ts', './profile-setup.service.ts']) {
		const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
		assert.match(s, /identityFieldCheckService\.triggerSafe\(/, f); assert.ok(!/await identityFieldCheckService/.test(s), `${f}: never awaited`);
	}
});
