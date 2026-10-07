import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// #20 — the admin sample detail carries the latest assessment attempt's "for review" marks (advisory data, read only).
process.env.OPENAI_API_KEY = 'test-key';
const state: any = { sample: null, attempt: null, attemptWhere: null };
let svc: Promise<any> | undefined;
const load = () => (svc ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: {
		accreditationSample: { findUnique: async () => state.sample },
		assessmentAttempt: { findFirst: async (a: any) => { state.attemptWhere = a.where; return state.attempt; } },
	} } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	return (await import('./accreditation-ai.service.ts')).accreditationAiService;
})());

test('the detail includes the review marks of the latest finished attempt of the sample\'s specialty', async () => {
	state.sample = { id: 's1', providerSpecialty: { id: 'ps1' } };
	state.attempt = { id: 'a1', score: 40, status: 'FAILED', completedAt: new Date(), analyzedAssetsSnapshot: { vendorAttemptId: 'v', review: { flagged: true, flags: [{ code: 'TOTAL_TIME_TOO_SHORT', label: 'x' }] } } };
	const d = await (await load()).getSampleByIdAdmin('s1');
	assert.equal(d.assessmentReview.review.flagged, true);
	assert.equal(d.assessmentReview.score, 40);
	assert.equal(state.attemptWhere.providerSpecialtyId, 'ps1');
	assert.doesNotMatch(JSON.stringify(d.assessmentReview), /vendorAttemptId|answerLog/, 'internal ids and the raw answer log are not exposed');
});

test('no attempt / an attempt without marks gives null review data, never an error', async () => {
	state.sample = { id: 's1', providerSpecialty: { id: 'ps1' } };
	state.attempt = null;
	assert.equal((await (await load()).getSampleByIdAdmin('s1')).assessmentReview, null);
	state.attempt = { id: 'a2', score: 90, status: 'COMPLETED', completedAt: new Date(), analyzedAssetsSnapshot: { vendorAttemptId: 'v' } };
	assert.equal((await (await load()).getSampleByIdAdmin('s1')).assessmentReview.review, null);
});
