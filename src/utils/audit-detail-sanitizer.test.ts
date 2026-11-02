import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, metaFacts, REDACTED, ALLOWED_META } from './audit-detail-sanitizer';

const UUID = '6d2bbf63-1a2b-4c3d-8e4f-0123456789ab';
test('redact: tokens, JWTs, links with secrets, OTP / password assignments, cards, IBAN, PayPal ids, long opaque strings never survive', () => {
	const secrets = [
		'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjMifQ.abcdefghijklmnop',
		'Bearer abc123def456ghi789',
		'https://waseetai.com/reset-password?token=abcdef123456',
		'https://x.test/verify/9f8e7d6c5b4a',
		'password: Sup3rSecret!', 'otp=123456', `api_key: ${['sk', 'live', '51Hxxxxxxxxxxxxxxxxxxxxx'].join('_')}`, 'secret = hunter2',
		'بطاقة 4111 1111 1111 1111', 'IBAN SA0380000000608010167519',
		'رقم عملية PayPal: 5TY05013RG002845M', 'capture 5TY05013RG002845M',
		'a3f9c2b7d1e84f6a9b0c5d2e7f1a8b3c4d5e6f708192a3b4c5d6e7f8091a2b3',
		'sessionId: 7a1c9d3e-1111-4222-8333-444455556666'
	];
	for (const s of secrets) {
		const out = redact(`حدث ${s} انتهى`);
		for (const frag of ['eyJ', 'abc123def456ghi789', 'token=abcdef', '9f8e7d6c5b4a', 'Sup3rSecret', '123456', 'sk_live', 'hunter2', '4111', 'SA0380000000608010167519', '5TY05013RG002845M', 'a3f9c2b7d1e8', '7a1c9d3e']) assert.ok(!out.includes(frag), `${frag} leaked from «${s}» -> ${out}`);
		assert.ok(out.includes(REDACTED), `nothing redacted in «${s}» -> ${out}`);
	}
});
test('redact: keeps what is not secret - entity UUIDs, ISO dates, Arabic sentences, e-mail is masked', () => {
	assert.equal(redact(`أُسند النزاع ${UUID} في 2026-10-26T12:00:00.000Z`), `أُسند النزاع ${UUID} في 2026-10-26T12:00:00.000Z`);
	assert.equal(redact('بدأت جلسة جديدة عبر Chrome على macOS'), 'بدأت جلسة جديدة عبر Chrome على macOS');
	assert.equal(redact('أُرسل إلى sara.alharbi@local.test'), 'أُرسل إلى sa***@local.test');
	assert.ok(redact('x'.repeat(500)).length <= 241);
});
test('metaFacts: ONLY allow-listed keys are read, whatever else the metadata holds', () => {
	const meta = { reason: 'تجاوز الحد', password: 'p@ss', token: 'eyJabcdefgh.abcdefghij.abcdefghi', otp: '123456', passwordHash: '$2b$10$abcdefghijklmnopqrstuv', apiKey: 'sk_live_abcdefghijklmnop', resetLink: 'https://x.test/reset?token=abc', sessionId: UUID, cardNumber: '4111111111111111', iban: 'SA0380000000608010167519', paypalCaptureId: '5TY05013RG002845M', changedFields: ['firstName', 'phone'] };
	const out = metaFacts(meta)!;
	assert.equal(out, 'السبب: تجاوز الحد · الحقول المعدّلة: firstName، phone');
	for (const k of Object.keys(meta)) if (!(k in ALLOWED_META)) assert.ok(!out.includes(String((meta as any)[k])), k);
	assert.equal(metaFacts({ password: 'x', token: 'y' }), null);
	// even an allowed key has its value redacted
	assert.ok(!metaFacts({ reason: 'password: hunter2 token=abc' })!.includes('hunter2'));
});
