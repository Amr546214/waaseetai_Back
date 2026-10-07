import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';
import { updateBasicsSchema, updateContactSchema } from '../dtos/profile-tab.dto';

// #14 (backend): avatarUrl null never erases the stored avatar (only '' is an explicit delete), and a PROVIDER avatar change recomputes completion.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

test('null avatarUrl means "not provided" in both save paths; \'\' stays an explicit delete; a URL passes through', () => {
	assert.equal('avatarUrl' in updateProfileSchema.parse({ avatarUrl: null }) && updateProfileSchema.parse({ avatarUrl: null }).avatarUrl, undefined);
	assert.equal(updateProfileSchema.parse({ avatarUrl: '' }).avatarUrl, '');
	assert.equal(updateProfileSchema.parse({ avatarUrl: 'https://res.cloudinary.com/x/a.png' }).avatarUrl, 'https://res.cloudinary.com/x/a.png');
	for (const schema of [updateBasicsSchema, updateContactSchema]) {
		assert.equal(schema.parse({ avatarUrl: null }).avatarUrl, undefined);
		assert.equal(schema.parse({ avatarUrl: '' }).avatarUrl, '');
	}
});

const state: { recalcs: string[]; upserts: any[] } = { recalcs: [], upserts: [] };
const tx: any = {
	user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE' }), update: async () => ({}) },
	providerProfile: { upsert: async (a: any) => { state.upserts.push(a.update); return { ...a.update }; } }
};
let loaded: Promise<any> | undefined;
const svc = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: { ...tx, $transaction: async (fn: any) => fn(tx) } } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	mock.module('./provider-profile.service', { namedExports: { providerProfileService: { recalculateProviderCompletion: async (id: string) => { state.recalcs.push(id); } } } });
	return (await import('./profile.service.ts')).profileService;
})());

test('PROVIDER updateTab with an avatar change recomputes the stored completion; with no display field it does not', async () => {
	state.recalcs = []; state.upserts = [];
	const service = await svc();
	await service.updateTab('u1', 'basics', { avatarUrl: 'https://res.cloudinary.com/x/a.png' }, 'PROVIDER');
	assert.deepEqual(state.recalcs, ['u1']);
	assert.equal(state.upserts[0].avatarUrl, 'https://res.cloudinary.com/x/a.png');
	state.recalcs = []; state.upserts = [];
	await service.updateTab('u1', 'basics', {}, 'PROVIDER');
	assert.deepEqual(state.recalcs, []);
	assert.equal(state.upserts.length, 0);
});
