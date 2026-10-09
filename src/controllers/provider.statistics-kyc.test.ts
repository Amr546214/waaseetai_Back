import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// #16 — GET /provider/statistics carries the provider's real kycStatus and the commission percentage stored for their level, or null (never a default).
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const state: any = { profile: null, gamification: null, proposals: [] };
let loaded: Promise<any> | undefined;
const load = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: {
		project: { count: async () => 0 }, proposal: { count: async () => 0, findMany: async () => state.proposals },
		providerProfile: { findUnique: async () => state.profile },
		providerGamification: { findUnique: async () => state.gamification },
	} } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	for (const m of ['../services/proposal.service', '../services/accreditation.service', '../services/project-progress.service', '../services/provider-deliveries.service']) {
		mock.module(m, { namedExports: { proposalService: {}, accreditationService: {}, projectProgressService: {}, providerDeliveriesService: {} } });
	}
	mock.module('../services/provider-overview.service', { namedExports: { providerOverviewService: { getLatestProviderActivity: async () => [], getAiMatchingProjects: async () => [] } } });
	mock.module('../services/provider-finance.service', { namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 0, releasedThisMonth: 0, escrowBalance: 0 } }) } } });
	return (await import('./provider.controller.ts')).getProviderStatistics;
})());

async function call() {
	const handler = await load();
	const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
	let err: any;
	await handler({ user: { id: 'p1' } } as any, res, (e: any) => { err = e; });
	assert.equal(err, undefined, String(err));
	return res.body.data.summary;
}
const profile = (over: any = {}) => ({ userId: 'p1', rating: 5, isProfileSetupComplete: true, setupTestStatus: 'PENDING', providerSpecialties: [], user: { firstName: 'م', lastName: 'خ' }, ...over });

test('a VERIFIED provider: kycStatus VERIFIED and the commission stored for their level', async () => {
	state.profile = profile({ kycStatus: 'VERIFIED' });
	state.gamification = { points: 0, currentLevelIndex: 0, currentCommission: 4.6 };
	const s = await call();
	assert.equal(s.kycStatus, 'VERIFIED');
	assert.equal(s.commissionPercent, 4.6);
});

test('other KYC states are passed as they are (PENDING / UNVERIFIED / REJECTED)', async () => {
	for (const kyc of ['PENDING', 'UNVERIFIED', 'REJECTED']) {
		state.profile = profile({ kycStatus: kyc });
		state.gamification = { points: 0, currentLevelIndex: 0, currentCommission: 5 };
		assert.equal((await call()).kycStatus, kyc);
	}
});

test('no gamification row / no profile value: both fields are null — nothing is defaulted or invented', async () => {
	state.profile = profile({ kycStatus: undefined });
	state.gamification = null;
	const s = await call();
	assert.equal(s.kycStatus, null);
	assert.equal(s.commissionPercent, null);
	state.gamification = { points: 1, currentLevelIndex: 0, currentCommission: undefined };
	assert.equal((await call()).commissionPercent, null);
});

test('a missing profile row gives null KYC and still answers', async () => {
	state.profile = null;
	state.gamification = null;
	const s = await call();
	assert.equal(s.kycStatus, null);
	assert.equal(s.commissionPercent, null);
});

test('aiRating: null (never 0) with no scored proposal; otherwise the real WaseetAI proposal-quality average out of 5, with its source', async () => {
	state.profile = profile(); state.gamification = null;
	state.proposals = [];
	let s = await call();
	assert.equal(s.aiRating, null);
	assert.equal(s.aiRatingSource, 'none');
	state.proposals = [{ aiMatchScore: 80, createdAt: new Date('2026-10-01') }, { aiMatchScore: 90, createdAt: new Date('2026-10-02') }];
	s = await call();
	assert.equal(s.aiRating, 4.3);
	assert.equal(s.aiRatingSource, 'waseet_ai_offer_quality');
	assert.equal(s.aiRatedOffersCount, 2);
	state.proposals = [];
});
