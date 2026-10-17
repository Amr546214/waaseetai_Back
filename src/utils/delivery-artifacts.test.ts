import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFolder, deliveryLinkProblem, validateDeliveryArtifacts, DELIVERY_MAX_LINKS, DELIVERY_MAX_UPLOADED_FILES } from './delivery-artifacts';

process.env.CLOUDINARY_CLOUD_NAME = 'waseet-test';
const P = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';
const own = (provider = P, stage = S, name = 'logo-1.png') => `https://res.cloudinary.com/waseet-test/image/upload/v1/${deliveryFolder(provider, stage)}/${name}`;
const rejects = (raw: unknown, re?: RegExp) => assert.throws(() => validateDeliveryArtifacts(P, S, raw), (e: any) => e.statusCode === 400 && (!re || re.test(e.message)));

test('a delivery with no artifact at all is refused', () => {
	rejects(undefined, /ملفاً واحداً/);
	rejects(null, /ملفاً واحداً/);
	rejects([], /ملفاً واحداً/);
	rejects('not-an-array', /ملفاً واحداً/);
	rejects([null, undefined], /ملفاً واحداً/);
});

test('a bare file name (what the old UI recorded) is refused — never stored', () => {
	rejects(['logo-final.png'], /ملفاً مرفوعاً فعلياً/);
	rejects([{ name: 'logo-final.png', size: 1200 }], /ملفاً مرفوعاً فعلياً/);
	rejects(['report.pdf, brand.zip']);
	rejects(['C:\\fakepath\\design.psd']);
});

test('links must be https and well formed', () => {
	rejects(['http://example.com/file.zip'], /https/);
	rejects(['ftp://example.com/file.zip'], /https/);
	rejects(['javascript:alert(1)'], /https/);
	rejects(['data:text/html;base64,AAAA'], /https/);
	rejects(['https://user:pass@example.com/x'], /بيانات دخول/);
	rejects(['https://example.com:8443/x'], /المنفذ/);
	rejects(['https://127.0.0.1/x'], /IP/);
	rejects(['https://[::1]/x'], /IP/);
	rejects(['https://localhost/x'], /غير صالح/);
	rejects(['https://intranet/x'], /غير صالح/);
	rejects([`https://example.com/${'a'.repeat(2100)}`], /طويل/);
	assert.equal(deliveryLinkProblem('https://drive.google.com/file/d/abc/view'), null);
});

test('a valid external https link counts as a delivery artifact and is stored as the plain URL', () => {
	assert.deepEqual(validateDeliveryArtifacts(P, S, ['https://www.figma.com/file/abc123/design']), ['https://www.figma.com/file/abc123/design']);
});

test('an uploaded file of THIS provider and THIS stage is accepted and stored as {name,url,type,size}', () => {
	const out = validateDeliveryArtifacts(P, S, [{ name: 'شعار.png', url: own(), type: 'image/png', size: 1234 }]);
	assert.equal(out.length, 1);
	assert.deepEqual(JSON.parse(out[0]), { name: 'شعار.png', url: own(), type: 'image/png', size: 1234 });
});

test('a Cloudinary URL outside this provider/stage folder is refused (cannot attach someone else\'s or another stage\'s file)', () => {
	rejects([{ url: own('99999999-9999-4999-8999-999999999999', S) }], /غير تابع لهذه المرحلة/);
	rejects([{ url: own(P, '33333333-3333-4333-8333-333333333333') }], /غير تابع لهذه المرحلة/);
	rejects([{ url: 'https://res.cloudinary.com/waseet-test/image/upload/v1/waseetai/accreditation/x/y.png' }], /غير تابع لهذه المرحلة/);
	rejects([{ url: own().replace('waseet-test', 'someone-elses-cloud') }], /غير تابع لهذه المرحلة/);
	rejects(['https://evil.cloudinary.com/waseet-test/image/upload/x.png'], /غير تابع لهذه المرحلة/);
});

test('files and links can be mixed; duplicates collapse; mixed names-only entry still refuses the whole delivery', () => {
	const out = validateDeliveryArtifacts(P, S, [{ url: own() }, { url: own() }, 'https://example.com/a', 'https://example.com/a']);
	assert.equal(out.length, 2);
	rejects([{ url: own() }, 'just-a-name.png'], /ملفاً مرفوعاً فعلياً/);
});

test('limits: at most 5 uploaded files and 5 links per delivery', () => {
	const files = Array.from({ length: DELIVERY_MAX_UPLOADED_FILES + 1 }, (_v, i) => ({ url: own(P, S, `f${i}.png`) }));
	rejects(files, /ملفات مرفوعة/);
	assert.equal(validateDeliveryArtifacts(P, S, files.slice(0, DELIVERY_MAX_UPLOADED_FILES)).length, DELIVERY_MAX_UPLOADED_FILES);
	const links = Array.from({ length: DELIVERY_MAX_LINKS + 1 }, (_v, i) => `https://example.com/${i}`);
	rejects(links, /روابط/);
});

test('file name metadata is sanitised (control characters stripped, length capped)', () => {
	const out = JSON.parse(validateDeliveryArtifacts(P, S, [{ name: `a\u0000b\n${'x'.repeat(400)}`, url: own(), size: -5, type: 'image/png' }])[0]);
	assert.ok(!/[\u0000-\u001f]/.test(out.name));
	assert.ok(out.name.length <= 200);
	assert.equal(out.size, 0);
});
