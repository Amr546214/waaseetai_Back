import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Admin KYC lists: every row says who owns it (name, e-mail, phone, userId, type) and how many documents it has, so the admin can tell which provider/client to approve.
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'test-key';
const user = (id: string, first: string, last: string, email: string) => ({ id, firstName: first, lastName: last, email, phoneNumber: '1066655544', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE' });
const profiles = [
	{ id: 'pp1', userId: 'u1', kycStatus: 'PENDING', isVerified: false, frontIdUrl: 'a', backIdUrl: 'b', selfieUrl: null, supportingDocsUrl: null, certUrls: ['c1', 'c2'], user: user('u1', 'مها', 'العباد', 'mayalabbad33+user01@gmail.com') },
	{ id: 'pp2', userId: 'u2', kycStatus: 'PENDING', isVerified: false, frontIdUrl: null, backIdUrl: null, selfieUrl: null, supportingDocsUrl: null, certUrls: [], user: user('u2', 'عمرو', '', 'amro.okasha.teamup@gmail.com') },
];
let loaded: Promise<any> | undefined;
const svc = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: {
		providerProfile: { findMany: async () => profiles, count: async () => profiles.length },
		clientOnboarding: { findMany: async () => [{ id: 'o1', userId: 'u9', user: { id: 'u9', firstName: 'ع', lastName: 'م', email: 'c@x.com', phoneNumber: '1', accountType: 'CLIENT_INDIVIDUAL' } }], count: async () => 1 },
		clientProfile: { findUnique: async () => ({ kycStatus: 'PENDING' }) },
	} } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	return (await import('./onboarding.service')).onboardingService;
})());

test('provider KYC list: userId, name, e-mail, phone, type and the document count are flat on every row', async () => {
	const r = await (await svc()).listProviderKyc();
	const a = r.items[0] as any;
	assert.equal(a.userId, 'u1');
	assert.equal(a.userName, 'مها العباد');
	assert.equal(a.userEmail, 'mayalabbad33+user01@gmail.com');
	assert.equal(a.userPhone, '1066655544');
	assert.equal(a.accountType, 'PROVIDER_INDIVIDUAL');
	assert.equal(a.kycStatus, 'PENDING');
	assert.equal(a.documentsCount, 4);
	assert.equal((r.items[1] as any).userName, 'عمرو');
	assert.equal((r.items[1] as any).documentsCount, 0);
});

test('client onboarding list carries the same flat owner fields', async () => {
	const r = await (await svc()).listOnboarding();
	assert.equal((r.items[0] as any).userEmail, 'c@x.com');
	assert.equal((r.items[0] as any).userName, 'ع م');
});
