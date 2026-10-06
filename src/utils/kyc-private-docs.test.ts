import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-secret';

// Private KYC storage: reference format, private upload options, the no-raw-reference guarantee on responses, the new value stays valid for
// every consumer that only checks presence (profile completion), and every upload path that must be private is.
const calls: any[] = [];
let loaded: Promise<any> | undefined;
function lib() {
	loaded ??= (async () => {
		mock.module('cloudinary', {
			namedExports: {
				v2: {
					config() {},
					uploader: {
						upload_stream(options: any, cb: any) {
							calls.push(options);
							return { end() { cb(null, { secure_url: 'https://res.cloudinary.com/testcloud/image/authenticated/s--sig--/v1/x.png', public_id: `${options.folder}/${options.public_id}`, format: 'png', bytes: 12 }); } };
						},
					},
					utils: { private_download_url: () => 'https://api.cloudinary.com/x' },
				},
			},
		});
		return {
			storage: await import('./cloudinary-storage'),
			ref: await import('./kyc-private-ref'),
			guard: await import('./kyc-value-guard'),
			scrub: await import('../middlewares/scrub-private-refs.middleware'),
			calc: await import('./completion-calculators'),
		};
	})();
	return loaded;
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('private reference: build/parse round trip, ownership by folder, junk rejected', async () => {
	const { ref } = await lib();
	const r = ref.buildPrivateRef({ resourceType: 'image', format: 'png', publicId: `waseetai/clients/${OWNER}/identity/front-id-1` });
	assert.match(r, /^private:image:png:waseetai\/clients\//);
	assert.deepEqual(ref.parsePrivateRef(r), { resourceType: 'image', format: 'png', publicId: `waseetai/clients/${OWNER}/identity/front-id-1` });
	assert.equal(ref.privateRefBelongsTo(r, OWNER), true);
	assert.equal(ref.privateRefBelongsTo(r, OTHER), false);
	for (const junk of ['private:image:png:../../etc/passwd', 'private:foo:png:waseetai/x', 'private:image:png:other-root/x', 'https://res.cloudinary.com/testcloud/x.png']) assert.equal(ref.parsePrivateRef(junk), null, junk);
});

test('a private upload uses type=authenticated and returns the reference; the default upload does not', async () => {
	const { storage, ref } = await lib();
	calls.length = 0;
	const priv = await storage.uploadCloudFile(PNG, { folder: `waseetai/clients/${OWNER}/identity`, fileName: 'front.png', mimeType: 'image/png', private: true });
	assert.equal(calls[0].type, 'authenticated');
	assert.ok(priv.privateRef && ref.parsePrivateRef(priv.privateRef), 'a valid private reference is returned');
	const pub = await storage.uploadCloudFile(PNG, { folder: 'waseetai/users/avatar', fileName: 'a.png', mimeType: 'image/png' });
	assert.equal(calls[1].type, undefined, 'avatars/gallery/services keep the default public upload');
	assert.equal(pub.privateRef, undefined);
});

test('storeKycFileIfNeeded: a data URI is stored private and the reference returned; other values pass through', async () => {
	const { storage } = await lib();
	calls.length = 0;
	const out = await storage.storeKycFileIfNeeded(`data:image/png;base64,${PNG.toString('base64')}`, `waseetai/clients/${OWNER}/identity`, 'front-id');
	assert.ok(String(out).startsWith('private:image:png:'));
	assert.equal(calls[0].type, 'authenticated');
	assert.equal(await storage.storeKycFileIfNeeded('', 'f', 'n'), '');
	assert.equal(await storage.storeKycFileIfNeeded(null, 'f', 'n'), null);
});

test('a private reference may be echoed back only by its owner', async () => {
	const { guard, ref } = await lib();
	const mine = ref.buildPrivateRef({ resourceType: 'image', format: 'png', publicId: `waseetai/clients/${OWNER}/identity/front-id-1` });
	assert.doesNotThrow(() => guard.assertKycFileValue(mine, OWNER));
	assert.throws(() => guard.assertKycFileValue(mine, OTHER), /مرجع/);
	assert.throws(() => guard.assertKycFileValue(mine), /مرجع/);
	assert.equal(guard.isAcceptableKycDocumentValue(mine, OWNER), true);
	assert.equal(guard.isAcceptableKycDocumentValue(mine, OTHER), false);
	assert.equal(guard.isAcceptableKycDocumentValue('https://evil.example/id.pdf', OWNER), false);
	assert.equal(guard.isAcceptableKycDocumentValue('https://res.cloudinary.com/testcloud/image/upload/id.pdf', OWNER), true);
});

test('no raw private reference leaves in a JSON response: nulled, with an Access marker; legacy URLs flagged; certificates arrays handled', async () => {
	const { scrub } = await lib();
	const PRIV = `private:image:png:waseetai/clients/${OWNER}/identity/front-id-1`;
	const out: any = scrub.__scrubForTest({
		success: true,
		data: { frontIdUrl: PRIV, backIdUrl: 'https://res.cloudinary.com/testcloud/image/upload/old.png', supportingDocsUrl: null, certUrls: [PRIV, 'https://res.cloudinary.com/testcloud/x.pdf'], nested: { items: [{ documentUrl: PRIV }] }, name: 'ok' },
	});
	assert.ok(!JSON.stringify(out).includes('private:'));
	assert.equal(out.data.frontIdUrl, null);
	assert.deepEqual(out.data.frontIdUrlAccess, { private: true, legacy: false });
	assert.deepEqual(out.data.backIdUrlAccess, { private: false, legacy: true });
	assert.equal(out.data.backIdUrl, 'https://res.cloudinary.com/testcloud/image/upload/old.png', 'legacy value stays during the transition');
	assert.deepEqual(out.data.certUrls, [null, 'https://res.cloudinary.com/testcloud/x.pdf']);
	assert.deepEqual(out.data.certUrlsAccess, [{ private: true, legacy: false }, { private: false, legacy: true }]);
	assert.equal(out.data.nested.items[0].documentUrl, null);
	assert.equal(out.data.name, 'ok');
});

test('profile completion stays correct for new (private) documents: the value is only checked for presence', async () => {
	const { calc } = await lib();
	const priv = `private:image:png:waseetai/clients/${OWNER}/identity/front-id-1`;
	const withUrls = { user: {}, clientProfile: { frontIdUrl: 'https://res.cloudinary.com/testcloud/image/upload/f.png', backIdUrl: 'https://res.cloudinary.com/testcloud/image/upload/b.png' } };
	const withRefs = { user: {}, clientProfile: { frontIdUrl: priv, backIdUrl: priv.replace('front', 'back') } };
	assert.equal(calc.computeClientCompletion(withRefs), calc.computeClientCompletion(withUrls));
	assert.deepEqual(calc.computeClientMissingItems(withRefs), calc.computeClientMissingItems(withUrls));
});

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('wiring: every KYC / proof upload path is private', () => {
	assert.match(read('controllers/client-profile.controller.ts'), /storeKycFileIfNeeded\(identity\.frontId/);
	assert.match(read('controllers/provider-profile.controller.ts'), /storeKycFileIfNeeded\(identity\?\.frontId/);
	assert.match(read('controllers/provider-profile.controller.ts'), /storeKycFileIfNeeded\(url, `waseetai\/providers\/\$\{userId\}\/certificates`/);
	assert.match(read('controllers/onboarding.controller.ts'), /uploadMulterFile\(req\.file, `waseetai\/clients\/\$\{req\.user!\.id\}\/onboarding`, undefined, true\)/);
	assert.match(read('routes/provider-profile.routes.ts'), /documents`, undefined, !isPublic\)/);
	assert.match(read('routes/provider-profile.routes.ts'), /req\.body\?\.visibility === 'public'/);
	assert.match(read('controllers/specialty.controller.ts'), /\/proofs`, undefined, true\)/);
	assert.match(read('routes/provider-specialty.routes.ts'), /isProof \? 'proofs' : 'samples'\}`, undefined, isProof\)/);
	assert.match(read('routes/accreditation-ai.routes.ts'), /\/proofs`, undefined, true\)/);
});

test('wiring: avatars, gallery, services and public samples keep the default public upload', () => {
	for (const f of ['services/profile.service.ts', 'services/marketer-profile.service.ts', 'routes/marketplace-service.routes.ts']) assert.doesNotMatch(read(f), /storeKycFileIfNeeded|undefined, true\)/, f);
});

test('wiring: the scrubbing middleware is installed app-wide and the access-link route is mounted', () => {
	const app = read('app.ts');
	assert.match(app, /app\.use\(scrubPrivateRefs\)/);
	assert.match(app, /mountAppRoute\('\/api\/kyc-documents', kycDocumentsRoutes\)/);
	assert.match(read('routes/kyc-documents.routes.ts'), /authenticate, requireActiveUser, createAccessLink/);
});

test('wiring: the two responses that must hand a reference to their caller opt out of scrubbing, and only those', () => {
	for (const f of ['routes/provider-profile.routes.ts', 'routes/accreditation-ai.routes.ts']) assert.match(read(f), /res\.locals\.allowPrivateRef = true/, f);
	const offenders = ['controllers/client-profile.controller.ts', 'controllers/provider-profile.controller.ts', 'controllers/onboarding.controller.ts', 'controllers/kyc-documents.controller.ts'].filter(f => /allowPrivateRef/.test(read(f)));
	assert.deepEqual(offenders, []);
});
