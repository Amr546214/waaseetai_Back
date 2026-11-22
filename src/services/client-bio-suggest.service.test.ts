import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

function load(t: TestContext, user: any) {
	t.mock.module('../config/db', { namedExports: { prisma: { user: { findUnique: async () => user } } } });
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: {} } });
	return import(`./client-bio-suggest.service.ts?fixture=${Date.now()}-${Math.random()}`).then(m => m.clientBioSuggestService);
}
const individual = { accountType: 'CLIENT_INDIVIDUAL', city: 'جدة', clientProfile: { industry: 'مهندس', bio: null, interests: ['تصميم'], companyName: null, city: 'الرياض' } };

test('an individual: what the user typed wins over what is stored; the audience comes from the ACCOUNT; the answer is returned, nothing is saved', async t => {
	const svc = await load(t, individual);
	let sent: any = null;
	const out = await svc.suggest('u1', { occupation: 'طبيب', interests: ['تسويق'] }, { suggestClientBio: async (b: any) => { sent = b; return { suggestedBio: 'أنا طبيب أطلب خدمات تسويق.' }; } } as any);
	assert.equal(out.suggestedBio, 'أنا طبيب أطلب خدمات تسويق.');
	assert.equal(sent.audience, 'individual'); assert.equal(sent.occupation, 'طبيب'); assert.deepEqual(sent.interests, ['تسويق']); assert.equal(sent.city, 'الرياض');
	assert.equal(sent.clientId, 'u1'); assert.equal(sent.maxLength, 500);
});

test('a company account is described as a company even if the request says nothing about it', async t => {
	const svc = await load(t, { accountType: 'CLIENT_COMPANY', city: null, clientProfile: { industry: 'عقارات', bio: null, interests: [], companyName: 'شركة الأمل', city: null } });
	let sent: any = null;
	await svc.suggest('u2', {}, { suggestClientBio: async (b: any) => { sent = b; return { suggestedBio: 'شركة عقارية.' }; } } as any);
	assert.equal(sent.audience, 'company'); assert.equal(sent.companyName, 'شركة الأمل'); assert.equal(sent.industry, 'عقارات'); assert.equal(sent.occupation, undefined);
});

test('nothing to work from is a 400 and the AI is not called', async t => {
	const svc = await load(t, { accountType: 'CLIENT_INDIVIDUAL', city: null, clientProfile: { industry: null, bio: null, interests: [], companyName: null, city: null } });
	let calls = 0;
	await assert.rejects(svc.suggest('u3', {}, { suggestClientBio: async () => { calls++; return { suggestedBio: 'x' }; } } as any), (e: any) => e.statusCode === 400);
	assert.equal(calls, 0);
});

test('an AI failure or an empty answer is an honest 503', async t => {
	const svc = await load(t, individual);
	await assert.rejects(svc.suggest('u1', {}, { suggestClientBio: async () => { throw new Error('boom'); } } as any), (e: any) => e.statusCode === 503);
	await assert.rejects(svc.suggest('u1', {}, { suggestClientBio: async () => ({ suggestedBio: '  ' }) } as any), (e: any) => e.statusCode === 503);
});
