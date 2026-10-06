import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';

// Stored KYC documents are private and no longer visible to the client, so the wizard re-sends empty identity fields on every re-save.
// An empty/absent identity or supporting-docs field must therefore mean "keep what is stored", never "erase it".
const upserts: any[] = [];
const prisma: any = {
	clientProfile: {
		upsert: async (a: any) => { upserts.push(a); return { id: 'cp1', userId: 'u1', idNumber: '1234567890', frontIdUrl: null, backIdUrl: null, kycStatus: 'UNVERIFIED' }; },
		update: async () => ({}),
		updateMany: async () => ({ count: 0 }),
		findUnique: async () => ({ kycStatus: 'UNVERIFIED' }),
	},
	user: { findUnique: async () => ({ id: 'u1' }) },
	clientOnboarding: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
	$transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops({})),
};
let loaded: Promise<any> | undefined;
function controller() {
	loaded ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null, storeKycFileIfNeeded: async (v: any) => v ?? null } });
		mock.module('../utils/completion-calculators', { namedExports: { computeClientCompletion: () => 80, computeClientMissingItems: () => [] } });
		return (await import('./client-profile.controller.ts')).ClientProfileController;
	})();
	return loaded;
}
async function save(identity: any, documents: any = {}) {
	upserts.length = 0;
	const Controller = await controller();
	const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
	await new Controller().saveSetupData({ user: { userId: 'u1' }, body: { details: { idNumber: '1234567890' }, identity, documents, agreements: {}, bank: {} } } as any, res, (e: any) => { throw e; });
	assert.equal(res.statusCode, 200);
	return upserts[0];
}

test('empty identity / supporting-docs fields are not written (the stored documents are kept)', async () => {
	const u = await save({ frontId: '', backId: '' }, { supportingDocs: '' });
	for (const part of [u.create, u.update]) {
		assert.equal(part.frontIdUrl, undefined);
		assert.equal(part.backIdUrl, undefined);
		assert.equal(part.supportingDocsUrl, undefined);
	}
	const absent = await save({});
	assert.equal(absent.update.frontIdUrl, undefined);
});

test('a newly uploaded document is still written', async () => {
	const u = await save({ frontId: 'data:image/png;base64,AAAA', backId: 'data:image/png;base64,AAAA' });
	assert.equal(u.update.frontIdUrl, 'data:image/png;base64,AAAA');
	assert.equal(u.update.backIdUrl, 'data:image/png;base64,AAAA');
});
