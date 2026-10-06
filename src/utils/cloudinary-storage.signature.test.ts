import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFileKind, contentMatchesDeclaredType } from './file-signature';
import { uploadCloudFile, uploadDataUri } from './cloudinary-storage';
import { AppError } from './app-error';

// AUD-FND-000042 — the declared mime type (multer file.mimetype / the data: header) is client-controlled; the bytes must agree with it.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const TEXT = Buffer.from('this is not an image');

test('detectFileKind recognises png, jpeg, gif, webp and pdf by their first bytes', () => {
	assert.deepEqual([PNG, JPG, GIF, WEBP, PDF].map(detectFileKind), ['png', 'jpeg', 'gif', 'webp', 'pdf']);
	assert.equal(detectFileKind(HTML), null);
	assert.equal(detectFileKind(TEXT), null);
	assert.equal(detectFileKind(Buffer.alloc(0)), null);
});

test('content must agree with the declared type; types we cannot verify pass through', () => {
	assert.equal(contentMatchesDeclaredType(PNG, 'image/png'), true);
	assert.equal(contentMatchesDeclaredType(JPG, 'image/jpeg'), true);
	assert.equal(contentMatchesDeclaredType(PDF, 'application/pdf'), true);
	assert.equal(contentMatchesDeclaredType(TEXT, 'image/png'), false, 'a text file renamed .png');
	assert.equal(contentMatchesDeclaredType(HTML, 'application/pdf'), false, 'html declared as pdf');
	assert.equal(contentMatchesDeclaredType(PDF, 'image/png'), false, 'a pdf declared as png');
	assert.equal(contentMatchesDeclaredType(TEXT, 'application/octet-stream'), true);
	assert.equal(contentMatchesDeclaredType(TEXT, 'video/mp4'), true);
});

async function rejects(fn: () => Promise<unknown>) {
	try { await fn(); } catch (e) { return e; }
	return null;
}

test('uploadCloudFile rejects a forged type with a clear Arabic 400, before Cloudinary is even configured', async () => {
	const err: any = await rejects(() => uploadCloudFile(TEXT, { folder: 'waseetai/test', fileName: 'id.png', mimeType: 'image/png' }));
	assert.ok(err instanceof AppError, 'must be an AppError (400), not a generic 500');
	assert.equal(err.statusCode, 400);
	assert.match(err.message, /لا يطابق/);
});

test('uploadDataUri rejects a data: header that lies about the content', async () => {
	const dataUri = `data:image/png;base64,${HTML.toString('base64')}`;
	const err: any = await rejects(() => uploadDataUri(dataUri, { folder: 'waseetai/test', fileName: 'id' }));
	assert.ok(err instanceof AppError);
	assert.equal(err.statusCode, 400);
});

test('a genuine image passes the signature stage (it then fails only on missing Cloudinary configuration, in this test environment)', async () => {
	delete process.env.CLOUDINARY_CLOUD_NAME;
	const err: any = await rejects(() => uploadCloudFile(PNG, { folder: 'waseetai/test', fileName: 'id.png', mimeType: 'image/png' }));
	assert.ok(err && !(err instanceof AppError));
	assert.match(String(err.message), /Cloudinary configuration/);
});
