import { test } from 'node:test';
import assert from 'node:assert/strict';

// «نموذج أعمال - …» rows are the setup's business models (file + proof verified at setup): the free portfolio endpoints cannot forge or alter them,
// otherwise a provider could fake the stored evidence the "setup complete" flag rests on.
process.env.OPENAI_API_KEY = 'test-key';
test('portfolio create / update refuse the reserved setup-model title (400) and never touch storage', async (t) => {
	let writes = 0;
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: {
		providerProfile: { findUnique: async () => ({ id: 'pp1' }) },
		portfolioItem: { findFirst: async ({ where }: any) => (where.id === 'm1' ? { id: 'm1', title: 'نموذج أعمال - واجهات' } : { id: 'f1', title: 'مشروعي' }), create: async () => { writes++; return {}; }, update: async () => { writes++; return {}; } },
	} } });
	t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v, privateFileExists: async () => true } });
	const { providerProfileService } = await import(`./provider-profile.service.ts?f=${Date.now()}-${Math.random()}`);
	await assert.rejects(() => providerProfileService.addPortfolioItem('u1', { title: 'نموذج أعمال - واجهات', tags: ['x'] }), (e: any) => e.statusCode === 400);
	await assert.rejects(() => providerProfileService.addPortfolioItem('u1', { title: '  نموذج أعمال - شعارات' }), (e: any) => e.statusCode === 400);
	await assert.rejects(() => providerProfileService.updatePortfolioItem('u1', 'm1', { description: 'x' }), (e: any) => e.statusCode === 400);
	await assert.rejects(() => providerProfileService.updatePortfolioItem('u1', 'f1', { title: 'نموذج أعمال - واجهات' }), (e: any) => e.statusCode === 400);
	assert.equal(writes, 0);
});

test('portfolio DELETE refuses a required setup model (clear Arabic message, nothing deleted) and still deletes an ordinary work', async (t) => {
	let deleted = 0;
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: {
		providerProfile: { findUnique: async () => ({ id: 'pp1', userId: 'u1', portfolioItems: [], skills: [] }), update: async () => ({}) },
		portfolioItem: { findFirst: async ({ where }: any) => (where.id === 'm1' ? { title: 'نموذج أعمال - واجهات' } : where.id === 'f1' ? { title: 'مشروعي' } : null), deleteMany: async () => { deleted++; return { count: 1 }; } },
	} } });
	t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v, privateFileExists: async () => true } });
	const { providerProfileService } = await import(`./provider-profile.service.ts?f=${Date.now()}-${Math.random()}`);
	await assert.rejects(() => providerProfileService.deletePortfolioItem('u1', 'm1'), (e: any) => e.statusCode === 400 && /مطلوب/.test(e.message) && /استكمال البيانات/.test(e.message));
	assert.equal(deleted, 0);
	await providerProfileService.deletePortfolioItem('u1', 'f1').catch(() => undefined); // the follow-up recalculation needs more of the fake; the delete itself ran
	assert.equal(deleted, 1);
});
