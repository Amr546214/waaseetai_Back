import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// #16 — GET /provider/statistics carries the provider's real kycStatus and the commission percentage stored for their level, or null (never a default).
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const state: any = { profile: null, gamification: null, proposals: [], reviews: 0, idDoc: null, docRequests: [] as any[] };
let loaded: Promise<any> | undefined;
const load = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: {
		project: { count: async () => 0 }, proposal: { count: async () => 0, findMany: async () => state.proposals },
		review: { count: async () => state.reviews },
		providerProfile: { findUnique: async () => state.profile },
		user: { findUnique: async () => ({ idDocumentUrl: state.idDoc }) },
		profileModificationRequest: {
			findFirst: async () => [...state.docRequests].sort((a: any, b: any) => b.createdAt - a.createdAt).find((r: any) => ['PENDING_HUMAN_REVIEW', 'REJECTED'].includes(r.status)) ?? null,
			count: async () => state.docRequests.filter((r: any) => r.status === 'PENDING_HUMAN_REVIEW').length,
		},
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

test('providerRating/humanRating: a real 5.0 stays 5.0; no client reviews or a missing/invalid stored rating -> null (never 0, never 5.0 by default)', async () => {
	state.gamification = null;
	state.reviews = 3; state.profile = profile({ rating: 5.0 });
	let s = await call();
	assert.equal(s.providerRating, 5); assert.equal(s.humanRating, 5);
	state.reviews = 3; state.profile = profile({ rating: 4.2 });
	s = await call(); assert.equal(s.providerRating, 4.2);
	state.reviews = 0; state.profile = profile({ rating: 5.0 }); // schema default, nobody rated yet
	s = await call(); assert.equal(s.providerRating, null); assert.equal(s.humanRating, null);
	state.reviews = 2; state.profile = profile({ rating: null });
	s = await call(); assert.equal(s.providerRating, null);
	state.reviews = 2; state.profile = profile({ rating: 0 }); // 0 is not a valid star rating
	s = await call(); assert.equal(s.providerRating, null);
	state.reviews = 0;
});

// ── the dashboard badge and the profile data page say the same thing (one derivation: identityVerification) ──
const idv = async (over: { kyc?: string | null; notes?: string | null; idDoc?: string | null; requests?: any[] }) => {
	state.profile = profile({ kycStatus: over.kyc ?? null, notes: over.notes ?? null }); state.gamification = null;
	state.idDoc = over.idDoc ?? null; state.docRequests = over.requests ?? [];
	return (await call()).identityVerification;
};
const req = (status: string, extra: any = {}) => ({ id: 'r1', status, createdAt: new Date('2026-10-10'), rejectionReason: null, ...extra });

test('VERIFIED document + a stale KYC "PENDING": the dashboard says VERIFIED, never "under review" (the contradiction that was reported)', async () => {
	const v = await idv({ kyc: 'PENDING', idDoc: 'private:ref', requests: [req('APPROVED')] });
	assert.equal(v.status, 'VERIFIED');
	const s = await call();
	assert.equal(s.kycStatus, 'PENDING', 'the raw column is still passed as it is');
});
test('PENDING_REVIEW only when something really waits: a request for the admin, or identity documents waiting in the KYC queue', async () => {
	assert.equal((await idv({ requests: [req('PENDING_HUMAN_REVIEW')] })).status, 'PENDING_REVIEW');
	assert.equal((await idv({ kyc: 'PENDING' })).status, 'PENDING_REVIEW');
	assert.equal((await idv({ kyc: 'PENDING', idDoc: 'private:ref' })).status, 'VERIFIED');
	assert.equal((await idv({})).status, 'NOT_SUBMITTED');
});
test('REJECTED: a refused KYC review or a rejected request, with the safe reason (never the raw notes)', async () => {
	const k = await idv({ kyc: 'REJECTED', notes: 'سبب الرفض: الصورة غير واضحة', idDoc: 'private:ref' });
	assert.deepEqual([k.status, k.rejectionReason], ['REJECTED', 'الصورة غير واضحة']);
	const g = await idv({ kyc: 'REJECTED', notes: 'ملاحظة داخلية سرية' });
	assert.equal(g.rejectionReason, 'تم رفض المستندات. يرجى رفع مستندات أوضح أو التواصل مع الدعم.');
	assert.equal((await idv({ requests: [req('REJECTED', { rejectionReason: 'x' })] })).status, 'REJECTED');
	assert.doesNotMatch(JSON.stringify(await call()), /ملاحظة داخلية سرية/);
});
test('a new waiting request overrides an old refusal; KYC VERIFIED without a stored document is VERIFIED', async () => {
	assert.equal((await idv({ kyc: 'REJECTED', notes: 'سبب الرفض: x', requests: [req('PENDING_HUMAN_REVIEW')] })).status, 'PENDING_REVIEW');
	assert.equal((await idv({ kyc: 'VERIFIED' })).status, 'VERIFIED');
});
test('a failed identity read gives null (no claim is made) and the rest of the dashboard still answers', async () => {
	state.profile = null; state.gamification = null;
	const s = await call();
	assert.ok(s.identityVerification === null || s.identityVerification?.status === 'NOT_SUBMITTED');
});
