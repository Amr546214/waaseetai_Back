import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectIdentityFile } from './identity-file-verdict';

const actor = { userId: 'u', role: 'marketer' as const };
const png = (n = 100) => ({ buffer: Buffer.alloc(n, 1), mimetype: 'image/png' });
const client = (r: any, configured = true) => ({ isConfigured: () => configured, inspectIdentityDocument: async () => { if (r instanceof Error) throw r; return r; } });
const ok = { status: 'CLEAR_VALID', isIdentityDocument: true, readability: 'CLEAR', summaryAr: 'وثيقة واضحة', warningsAr: [] };

test('a clear identity document is OK', async () => {
	assert.equal((await inspectIdentityFile(png(), actor, client(ok))).verdict, 'OK');
});
test('not an identity document, or unreadable, is REFUSED with the AI reason', async () => {
	const a = await inspectIdentityFile(png(), actor, client({ ...ok, status: 'NOT_ID_DOCUMENT', isIdentityDocument: false, summaryAr: 'ليست وثيقة هوية', warningsAr: ['أرفق هوية'] }));
	assert.equal(a.verdict, 'REFUSED'); assert.match(a.messageAr, /ليست وثيقة هوية/);
	assert.equal((await inspectIdentityFile(png(), actor, client({ ...ok, readability: 'UNREADABLE', status: 'UNREADABLE' }))).verdict, 'REFUSED');
});
test('a data difference or a blurry picture is not a refusal', async () => {
	assert.equal((await inspectIdentityFile(png(), actor, client({ ...ok, status: 'NEEDS_ATTENTION', readability: 'BLURRY', warningsAr: ['غير واضحة قليلًا'] }))).verdict, 'OK');
});
test('what the AI cannot judge is UNVERIFIED, never a refusal: AI down, not configured, too large, unsupported type', async () => {
	assert.equal((await inspectIdentityFile(png(), actor, client(new Error('down')))).verdict, 'UNVERIFIED');
	assert.equal((await inspectIdentityFile(png(), actor, client(ok, false))).verdict, 'UNVERIFIED');
	assert.equal((await inspectIdentityFile(png(8_000_000), actor, client(ok))).verdict, 'UNVERIFIED');
	assert.equal((await inspectIdentityFile({ buffer: Buffer.alloc(10), mimetype: 'application/zip' }, actor, client(ok))).verdict, 'UNVERIFIED');
});
