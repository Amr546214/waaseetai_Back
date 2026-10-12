import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { memoryUpload } from '../utils/cloudinary-storage';
import { DELIVERY_UPLOAD_MIME_TYPES } from '../utils/upload-mime-types';
import { DELIVERY_MAX_FILE_BYTES, DELIVERY_MAX_UPLOADED_FILES } from '../utils/delivery-artifacts';

// The suite does not boot Express, so the route is proven statically (same approach as admin-withdrawals.routes.test.ts),
// and the multer filter it uses is exercised directly.
const source = fs.readFileSync(path.join(__dirname, 'provider.routes.ts'), 'utf8');

test('POST /projects/:projectId/stages/:stageId/deliveries/files is wired: authenticate + requireActiveUser + providerOnly BEFORE multer, then the controller', () => {
	assert.match(source, /router\.post\('\/projects\/:projectId\/stages\/:stageId\/deliveries\/files',\s*authenticate,\s*requireActiveUser,\s*providerOnly,\s*deliveryUpload\.array\('files',\s*DELIVERY_MAX_UPLOADED_FILES\),\s*uploadStageDeliveryFiles\)/);
});

test('the delivery upload is capped at 25MB x 5 files and uses the delivery MIME allow-list', () => {
	assert.equal(DELIVERY_MAX_FILE_BYTES, 25 * 1024 * 1024);
	assert.equal(DELIVERY_MAX_UPLOADED_FILES, 5);
	assert.match(source, /memoryUpload\(\{\s*fileSize:\s*DELIVERY_MAX_FILE_BYTES,\s*files:\s*DELIVERY_MAX_UPLOADED_FILES,\s*allowedMimeTypes:\s*DELIVERY_UPLOAD_MIME_TYPES\s*\}\)/);
});

test('the JSON delivery route is still there (it now requires real artifacts, enforced in the service)', () => {
	assert.match(source, /router\.post\('\/projects\/:id\/stages\/:stageId\/deliveries',\s*authenticate,\s*requireActiveUser,\s*submitStageDelivery\)/);
});

test('delivery MIME allow-list: work files yes; svg / html / executables / scripts no', () => {
	for (const ok of ['image/png', 'image/jpeg', 'application/pdf', 'application/zip', 'video/mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv']) assert.ok(DELIVERY_UPLOAD_MIME_TYPES.has(ok), ok);
	for (const bad of ['image/svg+xml', 'text/html', 'application/x-msdownload', 'application/x-sh', 'application/javascript', 'application/octet-stream', 'application/x-httpd-php']) assert.ok(!DELIVERY_UPLOAD_MIME_TYPES.has(bad), bad);
});

test('the multer filter refuses a disallowed type with 415 and accepts an allowed one', async () => {
	const upload = memoryUpload({ fileSize: DELIVERY_MAX_FILE_BYTES, files: DELIVERY_MAX_UPLOADED_FILES, allowedMimeTypes: DELIVERY_UPLOAD_MIME_TYPES });
	const filter = (upload as any).fileFilter as (req: unknown, file: { mimetype: string }, cb: (err: any, ok?: boolean) => void) => void;
	const run = (mimetype: string) => new Promise<{ err: any; ok?: boolean }>(res => filter({}, { mimetype }, (err, ok) => res({ err, ok })));
	assert.equal((await run('image/svg+xml')).err?.statusCode, 415);
	assert.equal((await run('application/x-msdownload')).err?.statusCode, 415);
	assert.equal((await run('application/pdf')).ok, true);
	assert.equal((upload as any).limits.fileSize, 25 * 1024 * 1024);
	assert.equal((upload as any).limits.files, 5);
});
