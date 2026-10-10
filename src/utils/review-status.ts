// One review lifecycle for every role: NOT_SUBMITTED -> PENDING_REVIEW -> APPROVED | REJECTED.
// Only changes that a human admin decides are described here. E-mail-code-only changes (contact, PayPal) and immediate saves are never reported as a review.
export type ReviewState = 'NOT_SUBMITTED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export interface ReviewEntry {
	status: ReviewState;
	requestId: string | null;
	category: string | null;
	submittedAt: string | null;
	reviewedAt: string | null;
	rejectionReason: string | null;
}
export interface ReviewRow {
	id: string;
	category: string;
	/** ProfileModificationRequest / ProfileChangeRequest / ClientOnboarding status, as stored */
	status: string;
	createdAt: Date;
	updatedAt?: Date | null;
	rejectionReason?: string | null;
	/** false for rows that were applied by a code or immediately, never by an admin */
	reviewedByAdmin?: boolean | null;
}

export const NOT_SUBMITTED: ReviewEntry = { status: 'NOT_SUBMITTED', requestId: null, category: null, submittedAt: null, reviewedAt: null, rejectionReason: null };

const PENDING = new Set(['PENDING_HUMAN_REVIEW', 'IN_AI_REVIEW', 'PENDING_AI_REVIEW', 'PENDING_HUMAN_APPROVAL', 'PENDING']);
const APPROVED = new Set(['APPROVED', 'APPROVED_AND_APPLIED']);

const entry = (status: ReviewState, r: ReviewRow): ReviewEntry => ({
	status, requestId: r.id, category: r.category, submittedAt: r.createdAt.toISOString(),
	reviewedAt: status === 'PENDING_REVIEW' ? null : (r.updatedAt ?? r.createdAt).toISOString(),
	rejectionReason: status === 'REJECTED' ? (r.rejectionReason ?? null) : null,
});

/** A waiting request always wins; otherwise the newest decided one; cancelled / withdrawn / unreviewed rows are ignored. */
export function deriveReviewEntry(rows: ReviewRow[]): ReviewEntry {
	const byNewest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	const waiting = byNewest.find((r) => PENDING.has(r.status));
	if (waiting) return entry('PENDING_REVIEW', waiting);
	const decided = byNewest.find((r) => (APPROVED.has(r.status) && r.reviewedByAdmin !== false) || r.status === 'REJECTED');
	if (!decided) return { ...NOT_SUBMITTED };
	return entry(decided.status === 'REJECTED' ? 'REJECTED' : 'APPROVED', decided);
}

/** The 409 body every "a request is already waiting" refusal carries, so a page can show the waiting request instead of a bare error. */
export function alreadyPendingDetails(row: { id: string; category: string; createdAt: Date } | null | undefined, category: string) {
	return [{ code: 'REQUEST_ALREADY_PENDING', requestId: row?.id ?? null, category, submittedAt: row?.createdAt?.toISOString() ?? null }];
}
