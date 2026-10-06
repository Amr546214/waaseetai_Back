import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isOwnCloudinaryUrl } from './cloudinary-url';
import { assertKycFileValue } from './kyc-value-guard';
import { uploadCloudFile, uploadDataUri, ensureCloudinaryUrl, memoryUpload } from './cloudinary-storage';
import { SPECIALTY_UPLOAD_MIME_TYPES, CHAT_UPLOAD_MIME_TYPES } from './upload-mime-types';
import { AppError } from './app-error';

// AUD-FND-000042 follow-up (PR-C): no external URL is ever fetched/forwarded, SVG/markup is never accepted, oversized uploads are refused,
// and the upload routes that had no allow-list now have one.
process.env.CLOUDINARY_CLOUD_NAME = 'ourcloud';
delete process.env.CLOUDINARY_API_KEY; // so any attempt to reach Cloudinary would fail with a non-AppError "configuration is missing"

const OWN = 'https://res.cloudinary.com/ourcloud/image/upload/v1/waseetai/clients/u1/identity/front.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function rejection(fn: () => Promise<unknown>): Promise<any> {
	try { await fn(); } catch (e) { return e; }
	return null;
}
const refused = (e: any) => e instanceof AppError && e.statusCode === 400;

test('isOwnCloudinaryUrl accepts only https://res.cloudinary.com/<our cloud>/ and nothing lookalike', () => {
	assert.equal(isOwnCloudinaryUrl(OWN), true);
	for (const bad of [
		'https://res.cloudinary.com/othercloud/image/upload/x.png', // another Cloudinary account
		'https://evil.example/ourcloud/x.png',
		'https://res.cloudinary.com.evil.example/ourcloud/x.png',
		'http://res.cloudinary.com/ourcloud/x.png',
		'https://user:pw@res.cloudinary.com/ourcloud/x.png',
		'https://res.cloudinary.com:8443/ourcloud/x.png',
		'https://127.0.0.1/ourcloud/x.png',
		'https://localhost/ourcloud/x.png',
		'https://[::1]/ourcloud/x.png',
		'https://169.254.169.254/latest/meta-data',
		'not a url',
	]) assert.equal(isOwnCloudinaryUrl(bad), false, bad);
});

test('ensureCloudinaryUrl refuses external URLs outright (400) instead of fetching them', async () => {
	for (const url of ['https://evil.example/a.png', 'https://127.0.0.1/a.png', 'http://res.cloudinary.com/ourcloud/a.png', 'https://res.cloudinary.com/othercloud/a.png']) {
		assert.ok(refused(await rejection(() => ensureCloudinaryUrl(url, 'waseetai/x', 'a'))), url);
	}
	assert.equal(await ensureCloudinaryUrl(OWN, 'waseetai/x', 'a'), OWN, 'a URL already in our account is kept untouched');
	assert.equal(await ensureCloudinaryUrl('', 'waseetai/x', 'a'), '');
});

test('KYC fields: external links refused; data URIs (png/jpeg/webp/pdf only) and our own URLs accepted', () => {
	for (const ok of [undefined, null, '', OWN, 'data:image/png;base64,AAAA', 'data:image/jpeg;base64,AAAA', 'data:application/pdf;base64,AAAA']) assert.doesNotThrow(() => assertKycFileValue(ok));
	for (const bad of ['https://evil.example/id.png', 'https://res.cloudinary.com/othercloud/id.png', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'javascript:alert(1)']) {
		assert.throws(() => assertKycFileValue(bad), (e: any) => refused(e), bad);
	}
});

test('SVG and markup are never accepted: declared svg, svg bytes under another declared type, and svg data URIs', async () => {
	assert.ok(refused(await rejection(() => uploadCloudFile(SVG, { folder: 'f', fileName: 'a.svg', mimeType: 'image/svg+xml' }))));
	assert.ok(refused(await rejection(() => uploadCloudFile(SVG, { folder: 'f', fileName: 'a.bin', mimeType: 'application/octet-stream' }))));
	assert.ok(refused(await rejection(() => uploadCloudFile(Buffer.from('  <!DOCTYPE html><html></html>'), { folder: 'f', fileName: 'a.bin' }))));
	assert.ok(refused(await rejection(() => uploadDataUri(`data:image/svg+xml;base64,${SVG.toString('base64')}`, { folder: 'f', fileName: 'a' }))));
});

test('oversized uploads are refused: by buffer size and, for data URIs, from the base64 length before decoding', async () => {
	assert.ok(refused(await rejection(() => uploadCloudFile(Buffer.alloc(2048, 1), { folder: 'f', fileName: 'a.png', mimeType: 'image/png', maxBytes: 1024 }))));
	const big = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(4096)]).toString('base64')}`;
	assert.ok(refused(await rejection(() => uploadDataUri(big, { folder: 'f', fileName: 'a', maxBytes: 1024 }))));
});

test('memoryUpload allow-lists: svg/html refused with a 400, codec parameters on voice notes tolerated', async () => {
	const filter = (memoryUpload({ allowedMimeTypes: CHAT_UPLOAD_MIME_TYPES }) as any).fileFilter as (req: any, file: any, cb: (e: any, ok?: boolean) => void) => void;
	const run = (mimetype: string) => new Promise<{ err: any; ok?: boolean }>(res => filter({}, { mimetype }, (err, ok) => res({ err, ok })));
	assert.equal((await run('audio/webm;codecs=opus')).ok, true);
	assert.equal((await run('image/png')).ok, true);
	for (const bad of ['image/svg+xml', 'text/html', 'application/x-msdownload', 'application/javascript']) {
		const r = await run(bad);
		assert.ok(refused(r.err), bad);
	}
	assert.equal(SPECIALTY_UPLOAD_MIME_TYPES.has('image/svg+xml'), false);
	assert.equal(CHAT_UPLOAD_MIME_TYPES.has('image/svg+xml'), false);
});

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('wiring: the three routes that had no allow-list now pass one', () => {
	assert.match(read('routes/specialty.routes.ts'), /memoryUpload\(\{[^}]*allowedMimeTypes: SPECIALTY_UPLOAD_MIME_TYPES/);
	assert.match(read('routes/provider-specialty.routes.ts'), /memoryUpload\(\{[^}]*allowedMimeTypes: SPECIALTY_UPLOAD_MIME_TYPES/);
	assert.match(read('routes/chat.routes.ts'), /memoryUpload\(\{[^}]*allowedMimeTypes: CHAT_UPLOAD_MIME_TYPES/);
});

test('wiring: client and provider KYC fields are validated before anything is stored', () => {
	assert.match(read('controllers/client-profile.controller.ts'), /assertKycFileValues\(\[identity\.frontId, identity\.backId, documents\.supportingDocs\], userId\)/);
	assert.match(read('controllers/provider-profile.controller.ts'), /assertKycFileValues\(\[identity\?\.frontId, identity\?\.backId, documents\?\.supportingDocs/);
});
