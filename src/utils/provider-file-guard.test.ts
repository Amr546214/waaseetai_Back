import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProviderFileAcceptable, assertDataUriFileAcceptable, isProviderFileKind, PROVIDER_FILE_REFUSED } from './provider-file-guard';

const actor = { userId: 'u1', role: 'provider' } as const;
const png = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimetype: 'image/png' };
const client = (over: Record<string, unknown> = {}) => ({
	isConfigured: () => true,
	inspectIdentityDocument: async () => ({ status: 'CLEAR_VALID', isIdentityDocument: true, readability: 'CLEAR', summaryAr: 'ok', warningsAr: [] }),
	inspectSelfie: async () => ({ status: 'CLEAR_VALID', summaryAr: 'ok', warningsAr: [] }),
	inspectCertificate: async () => ({ status: 'CLEAR_VALID', summaryAr: 'ok', warningsAr: [] }),
	...over
}) as any;
const refused = (e: any) => e.statusCode === 422 && e.code === PROVIDER_FILE_REFUSED;

test('kinds are validated', () => { assert.ok(isProviderFileKind('SELFIE')); assert.ok(!isProviderFileKind('AVATAR')); assert.ok(!isProviderFileKind(undefined)); });

test('identity document: not an ID / unreadable is refused, a real one passes', async () => {
	await assert.rejects(() => assertProviderFileAcceptable('ID_DOCUMENT', png, actor, client({ inspectIdentityDocument: async () => ({ status: 'NOT_ID_DOCUMENT', isIdentityDocument: false, summaryAr: 'شعار', warningsAr: [] }) })), refused);
	await assert.rejects(() => assertProviderFileAcceptable('ID_DOCUMENT', png, actor, client({ inspectIdentityDocument: async () => ({ status: 'UNREADABLE', readability: 'UNREADABLE', warningsAr: [] }) })), refused);
	await assertProviderFileAcceptable('ID_DOCUMENT', png, actor, client());
});
test('selfie: no person is refused with the reasons, a person with the document passes', async () => {
	await assert.rejects(() => assertProviderFileAcceptable('SELFIE', png, actor, client({ inspectSelfie: async () => ({ status: 'NOT_A_SELFIE', summaryAr: 'لا يوجد شخص', warningsAr: [] }) })), (e: any) => refused(e) && /لا يوجد شخص/.test(e.message));
	await assertProviderFileAcceptable('SELFIE', png, actor, client());
	await assertProviderFileAcceptable('SELFIE', png, actor, client({ inspectSelfie: async () => ({ status: 'NEEDS_ATTENTION', summaryAr: 'x', warningsAr: [] }) })); // a remark is not a refusal
});
test('certificate: not a certificate / unreadable is refused; remarks pass', async () => {
	await assert.rejects(() => assertProviderFileAcceptable('CERTIFICATE', png, actor, client({ inspectCertificate: async () => ({ status: 'NOT_CERTIFICATE', summaryAr: 'x', warningsAr: [] }) })), refused);
	await assert.rejects(() => assertProviderFileAcceptable('CERTIFICATE', png, actor, client({ inspectCertificate: async () => ({ status: 'UNREADABLE', summaryAr: 'x', warningsAr: [] }) })), refused);
	await assertProviderFileAcceptable('CERTIFICATE', png, actor, client({ inspectCertificate: async () => ({ status: 'NEEDS_ATTENTION', summaryAr: 'x', warningsAr: [] }) }));
});
test('fail-open: AI down, not configured, a PDF certificate or a huge file are accepted for human review', async () => {
	const down = client({ inspectSelfie: async () => { throw new Error('down'); }, inspectCertificate: async () => { throw new Error('down'); }, inspectIdentityDocument: async () => { throw new Error('down'); } });
	for (const k of ['ID_DOCUMENT', 'SELFIE', 'CERTIFICATE'] as const) await assertProviderFileAcceptable(k, png, actor, down);
	await assertProviderFileAcceptable('SELFIE', png, actor, client({ isConfigured: () => false, inspectSelfie: async () => ({ status: 'NOT_A_SELFIE' }) }));
	await assertProviderFileAcceptable('CERTIFICATE', { buffer: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf' }, actor, client({ inspectCertificate: async () => ({ status: 'NOT_CERTIFICATE' }) }));
	await assertProviderFileAcceptable('SELFIE', { buffer: Buffer.alloc(7_500_001), mimetype: 'image/png' }, actor, client({ inspectSelfie: async () => ({ status: 'NOT_A_SELFIE' }) }));
});

const uri = (mime = 'image/png') => `data:${mime};base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`;
test('data: URI in a KYC slot runs the same AI check (refused when clearly wrong)', async () => {
	await assert.rejects(() => assertDataUriFileAcceptable(uri(), 'SELFIE', actor, client({ inspectSelfie: async () => ({ status: 'NOT_A_SELFIE', summaryAr: 'x', warningsAr: [] }) })), refused);
	await assert.rejects(() => assertDataUriFileAcceptable(uri('image/jpg'), 'ID_DOCUMENT', actor, client({ inspectIdentityDocument: async () => ({ status: 'NOT_ID_DOCUMENT', isIdentityDocument: false, warningsAr: [] }) })), refused);
	await assertDataUriFileAcceptable(uri(), 'SELFIE', actor, client());
});
test('non data: values (references, urls, empty, malformed) are left to the other guards', async () => {
	const never = client({ inspectSelfie: async () => { throw new Error('should not be called'); }, inspectCertificate: async () => ({ status: 'NOT_CERTIFICATE' }) });
	for (const v of ['private:image:png:waseetai/x', 'https://res.cloudinary.com/x.png', '', null, undefined, 'data:image/png;base64', 42]) await assertDataUriFileAcceptable(v, 'CERTIFICATE', actor, never);
});
