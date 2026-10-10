import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReviewEntry, alreadyPendingDetails, type ReviewRow } from './review-status';

const d = (n: number) => new Date(2026, 9, n);
const row = (o: Partial<ReviewRow> & { id: string; status: string }): ReviewRow => ({ category: 'DOCUMENTS', createdAt: d(1), ...o });

test('no rows -> NOT_SUBMITTED', () => {
	assert.equal(deriveReviewEntry([]).status, 'NOT_SUBMITTED');
});
test('a waiting request -> PENDING_REVIEW with id, category and submittedAt, no reason', () => {
	const e = deriveReviewEntry([row({ id: 'a', status: 'PENDING_HUMAN_REVIEW', createdAt: d(5) })]);
	assert.deepEqual([e.status, e.requestId, e.category, e.submittedAt, e.rejectionReason, e.reviewedAt], ['PENDING_REVIEW', 'a', 'DOCUMENTS', d(5).toISOString(), null, null]);
});
test('a waiting request wins over older decided ones (resubmit after a rejection)', () => {
	const e = deriveReviewEntry([row({ id: 'old', status: 'REJECTED', createdAt: d(1), rejectionReason: 'x' }), row({ id: 'new', status: 'PENDING_HUMAN_REVIEW', createdAt: d(3) })]);
	assert.equal(e.status, 'PENDING_REVIEW'); assert.equal(e.requestId, 'new'); assert.equal(e.rejectionReason, null);
});
test('rejected carries the admin reason; approved carries none', () => {
	const r = deriveReviewEntry([row({ id: 'r', status: 'REJECTED', rejectionReason: 'الصورة غير واضحة', updatedAt: d(4) })]);
	assert.deepEqual([r.status, r.rejectionReason, r.reviewedAt], ['REJECTED', 'الصورة غير واضحة', d(4).toISOString()]);
	const a = deriveReviewEntry([row({ id: 'p', status: 'APPROVED', reviewedByAdmin: true })]);
	assert.deepEqual([a.status, a.rejectionReason], ['APPROVED', null]);
});
test('the newest decision wins (rejected, then approved)', () => {
	const e = deriveReviewEntry([row({ id: 'r', status: 'REJECTED', createdAt: d(1) }), row({ id: 'a', status: 'APPROVED', createdAt: d(2), reviewedByAdmin: true })]);
	assert.equal(e.status, 'APPROVED'); assert.equal(e.requestId, 'a');
});
test('rows never decided by an admin (immediate / code-applied, reviewedByAdmin=false), cancelled and withdrawn rows are not a review', () => {
	assert.equal(deriveReviewEntry([row({ id: 'i', status: 'APPROVED', reviewedByAdmin: false })]).status, 'NOT_SUBMITTED');
	assert.equal(deriveReviewEntry([row({ id: 'c', status: 'CANCELLED' }), row({ id: 'w', status: 'WITHDRAWN' })]).status, 'NOT_SUBMITTED');
});
test('marketer statuses map the same way', () => {
	assert.equal(deriveReviewEntry([row({ id: 'm', status: 'PENDING_AI_REVIEW' })]).status, 'PENDING_REVIEW');
	assert.equal(deriveReviewEntry([row({ id: 'm', status: 'APPROVED_AND_APPLIED' })]).status, 'APPROVED');
});
test('409 details name the waiting request', () => {
	assert.deepEqual(alreadyPendingDetails({ id: 'x', category: 'DOCUMENTS', createdAt: d(2) }, 'DOCUMENTS'), [{ code: 'REQUEST_ALREADY_PENDING', requestId: 'x', category: 'DOCUMENTS', submittedAt: d(2).toISOString() }]);
	assert.equal(alreadyPendingDetails(null, 'C')[0].requestId, null);
});
