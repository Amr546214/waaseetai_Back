import { Prisma, PaypalWebhookEventStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { payoutService } from './payout.service';

// ============================================================================
// Payout P3-D: PayPal payout webhook processing — durable event
// deduplication (with stale-event reclaim), narrow identity correlation,
// and delegation to the existing, already-hardened P3-C
// reconcilePayoutAttempt() for every actual financial decision.
//
// This file NEVER implements its own payout status state machine and NEVER
// decides a financial outcome from event_type, an embedded transaction
// status, or a batch status — see reconcilePayoutAttempt()'s own doc
// comment for why that authority stays there. This file's only job is: (1)
// durably record the event exactly once, (2) safely identify WHICH
// PayoutAttempt it concerns (or prove it cannot), and (3) call the one
// existing reconciliation entry point.
// ============================================================================

// Official PayPal payout webhook event names (confirmed against PayPal's own
// documentation, provided directly for this task — not guessed). Kept
// completely separate from paypal-webhook.controller.ts's own
// SUPPORTED_EVENT_TYPES (the deposit/capture allowlist): a payout event must
// never reach the deposit handlers, and a deposit event must never reach
// this file. PayPal explicitly documents that PAYOUTSBATCH events carry NO
// item-level information — this allowlist and the identifier extraction
// below are both written with that constraint in mind (batch events simply
// never yield an item-level identifier; no special-casing is needed since
// extraction is already purely presence-based).
export const SUPPORTED_PAYOUT_EVENT_TYPES = new Set([
	'PAYMENT.PAYOUTSBATCH.DENIED',
	'PAYMENT.PAYOUTSBATCH.PROCESSING',
	'PAYMENT.PAYOUTSBATCH.SUCCESS',
	'PAYMENT.PAYOUTS-ITEM.BLOCKED',
	'PAYMENT.PAYOUTS-ITEM.CANCELED',
	'PAYMENT.PAYOUTS-ITEM.FAILED',
	'PAYMENT.PAYOUTS-ITEM.HELD',
	'PAYMENT.PAYOUTS-ITEM.REFUNDED',
	'PAYMENT.PAYOUTS-ITEM.RETURNED',
	'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
	'PAYMENT.PAYOUTS-ITEM.UNCLAIMED'
]);

// Payout P3-D concurrency-review verdict: a RECEIVED/FAILED row older than
// this is treated as abandoned (the worker that claimed it crashed) and is
// safe to reclaim. Chosen as a wide, conservative multiple of
// reconcilePayoutAttempt()'s own worst-case duration (two sequential
// 15s-bounded PayPal calls plus a handful of sub-second DB writes — well
// under a minute even in the worst case), so a genuinely still-processing
// request is never wrongly reclaimed. See the P3-D concurrency review for
// the full timing analysis this constant is derived from.
const ABANDONMENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface PayoutWebhookProcessResult {
	httpStatus: number;
}

/**
 * Narrow, bounded extraction of ONLY the three identifiers the safe
 * correlation hierarchy below can ever use — nothing else is ever read from
 * `resource`. Every field is read flat (no nested-object guessing, matching
 * the same discipline paypal.service.ts's own P3-B review already applied
 * to the GET-by-batch-id response): `payout_item_id`/`payout_batch_id`
 * mirror the exact flat field names this project has ALREADY confirmed
 * PayPal uses for the equivalent item-level fields on getPayoutBatch()'s own
 * response (see paypal.service.ts) — the webhook `resource` object is
 * PayPal's own documented pattern of exposing a trimmed version of the same
 * underlying resource, so reusing those exact, already-confirmed field
 * names here is the most narrowly justified guess available, not a fresh
 * invention.
 *
 * `senderBatchId` is DELIBERATELY never populated: nothing in this project's
 * confirmed PayPal contract (nor any captured Sandbox payload) establishes
 * where, or whether, a payout webhook resource exposes a sender_batch_id at
 * all — this is an explicit, reported Sandbox-characterization blocker (see
 * this task's own final report), not an oversight. The third correlation
 * tier below remains implemented and unit-tested on its own so it is ready
 * the moment that field is empirically confirmed, but it can never actually
 * fire from this extractor today.
 */
export interface ExtractedPayoutIdentifiers {
	payoutItemId?: string;
	payoutBatchId?: string;
	senderBatchId?: string;
}

function readSafeString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractPayoutWebhookIdentifiers(resource: unknown): ExtractedPayoutIdentifiers {
	if (!resource || typeof resource !== 'object') return {};
	const r = resource as Record<string, unknown>;
	return {
		payoutItemId: readSafeString(r.payout_item_id),
		payoutBatchId: readSafeString(r.payout_batch_id)
		// senderBatchId intentionally omitted — see this function's own doc comment.
	};
}

/**
 * Bounded, allowlisted persistence shape for `PaypalWebhookEvent.rawEvent`.
 * Only the three correlation identifiers this file itself extracts — never
 * the receiver/recipient email, never an amount, never any free-text
 * error/reason field, never headers or tokens. Deliberately excludes
 * undefined keys rather than storing them as explicit nulls.
 */
function buildSanitizedRawEvent(identifiers: ExtractedPayoutIdentifiers): Prisma.InputJsonValue | undefined {
	const entries = Object.entries(identifiers).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries) as Prisma.InputJsonValue;
}

function parseSafeDate(value: unknown): Date | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

type ClaimOutcome =
	| { outcome: 'CLAIMED'; eventRowId: string }
	| { outcome: 'STAND_DOWN' };

/**
 * Payout P3-D concurrency-review implementation: first receipt durably
 * claims the row via INSERT; a duplicate paypalEventId either stands down
 * (already PROCESSED, or RECEIVED/FAILED but recently touched — plausibly
 * still being actively worked on elsewhere) or, if the existing row has been
 * untouched for at least ABANDONMENT_TIMEOUT_MS, attempts exactly ONE atomic
 * compare-and-swap reclaim keyed on the EXACT previously-read
 * (status, updatedAt) pair. Only `count === 1` from that conditional
 * `updateMany` may proceed — a concurrent racer's own CAS attempt is
 * guaranteed to see the winner's freshly-written `updatedAt` and correctly
 * match zero rows. No transaction is ever held open across this function —
 * every branch is a single, already-committed statement, and the PayPal
 * network call (inside reconcilePayoutAttempt(), called by this function's
 * caller only AFTER this returns) never runs inside one.
 *
 * A future-dated `updatedAt` (clock skew / data-integrity anomaly) is never
 * reclaimed — conservatively treated the same as "stand down", logged for
 * investigation, with zero financial transition.
 */
async function claimOrStandDown(params: {
	paypalEventId: string;
	eventType: string;
	resourceType?: string;
	paypalCreateTime?: Date;
	rawEvent?: Prisma.InputJsonValue;
}): Promise<ClaimOutcome> {
	try {
		const created = await prisma.paypalWebhookEvent.create({
			data: {
				paypalEventId: params.paypalEventId,
				eventType: params.eventType,
				resourceType: params.resourceType,
				paypalCreateTime: params.paypalCreateTime,
				rawEvent: params.rawEvent,
				status: PaypalWebhookEventStatus.RECEIVED
			}
		});
		return { outcome: 'CLAIMED', eventRowId: created.id };
	} catch (error) {
		if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
			// Not a duplicate-event race — an unexpected/unclassified error.
			// Never silently swallowed: propagate so the caller's own
			// unexpected-exception handling (5xx, no bookkeeping possible
			// since no row was ever durably created) applies.
			throw error;
		}

		const existing = await prisma.paypalWebhookEvent.findUnique({ where: { paypalEventId: params.paypalEventId } });
		if (!existing) {
			// Vanishingly unlikely (the row was deleted between the failed
			// INSERT and this read) — conservatively stand down rather than
			// guess at ownership.
			return { outcome: 'STAND_DOWN' };
		}

		if (existing.status === PaypalWebhookEventStatus.PROCESSED) {
			return { outcome: 'STAND_DOWN' };
		}

		const ageMs = Date.now() - existing.updatedAt.getTime();
		if (ageMs < 0) {
			logger.warn(`payout-webhook: PaypalWebhookEvent ${existing.id} (paypalEventId=${params.paypalEventId}) has a future-dated updatedAt — clock-skew/data-integrity anomaly, standing down without reclaiming.`);
			return { outcome: 'STAND_DOWN' };
		}
		if (ageMs < ABANDONMENT_TIMEOUT_MS) {
			// Plausibly still being actively processed elsewhere right now —
			// conservatively stand down. Getting this wrong is not a
			// financial-safety issue (reconcilePayoutAttempt() is itself
			// idempotent under concurrent invocation) — this is purely an
			// operational/noise-avoidance preference.
			return { outcome: 'STAND_DOWN' };
		}

		// Stale — attempt the one atomic reclaim. `now` is captured once and
		// used as BOTH the explicit fresh token written to `updatedAt` and
		// (implicitly, by virtue of being freshly generated) the value any
		// concurrent racer's own read will observe afterward.
		const now = new Date();
		const reclaim = await prisma.paypalWebhookEvent.updateMany({
			where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
			data: { status: PaypalWebhookEventStatus.RECEIVED, updatedAt: now }
		});
		if (reclaim.count !== 1) {
			// Lost the race to a concurrent reclaimer — stand down.
			return { outcome: 'STAND_DOWN' };
		}
		return { outcome: 'CLAIMED', eventRowId: existing.id };
	}
}

/**
 * Payout P3-D — CORE SAFETY RULE (mirrors payout.service.ts's own
 * correlatePayoutItem()): uses the STRONGEST available identifier only, in
 * priority order, never falling back to a weaker identifier after a
 * stronger one fails to match, and never combining identifiers. Zero or
 * multiple matches at any tier means "cannot prove correlation" for that
 * tier — no correlation, full stop, never a fallback opportunity.
 *
 *  1. payoutItemId — exact unique match (the column's own @unique
 *     constraint on PayoutAttempt makes findUnique() itself the proof).
 *  2. payoutBatchId — NOT unique at the DB level (a defensive design
 *     choice, not an assumption of uniqueness) — requires findMany() and
 *     EXACTLY one result.
 *  3. senderBatchId — exact unique match, but per extractPayoutWebhookIdentifiers()'s
 *     own doc comment this is never actually populated today, so this tier
 *     is implemented and independently tested but currently unreachable
 *     from a real webhook payload.
 *
 * Returns null if no identifier was extracted at all, or if the one
 * identifier present yields zero/multiple matches.
 */
export async function correlatePayoutAttempt(identifiers: ExtractedPayoutIdentifiers): Promise<{ attemptId: string } | null> {
	if (identifiers.payoutItemId) {
		const attempt = await prisma.payoutAttempt.findUnique({ where: { payoutItemId: identifiers.payoutItemId }, select: { id: true } });
		return attempt ? { attemptId: attempt.id } : null;
	}
	if (identifiers.payoutBatchId) {
		const attempts = await prisma.payoutAttempt.findMany({ where: { payoutBatchId: identifiers.payoutBatchId }, select: { id: true } });
		return attempts.length === 1 ? { attemptId: attempts[0].id } : null;
	}
	if (identifiers.senderBatchId) {
		const attempt = await prisma.payoutAttempt.findUnique({ where: { senderBatchId: identifiers.senderBatchId }, select: { id: true } });
		return attempt ? { attemptId: attempt.id } : null;
	}
	return null;
}

async function markEventFailed(eventRowId: string, payoutAttemptId?: string): Promise<void> {
	await prisma.paypalWebhookEvent.updateMany({
		where: { id: eventRowId, status: PaypalWebhookEventStatus.RECEIVED },
		data: { status: PaypalWebhookEventStatus.FAILED, updatedAt: new Date(), ...(payoutAttemptId ? { payoutAttemptId } : {}) }
	});
}

async function markEventProcessed(eventRowId: string, payoutAttemptId: string): Promise<void> {
	await prisma.paypalWebhookEvent.updateMany({
		where: { id: eventRowId, status: PaypalWebhookEventStatus.RECEIVED },
		data: { status: PaypalWebhookEventStatus.PROCESSED, updatedAt: new Date(), processedAt: new Date(), payoutAttemptId }
	});
}

/**
 * Payout P3-D — the one entry point the webhook controller calls for every
 * event whose `event_type` is in SUPPORTED_PAYOUT_EVENT_TYPES, AFTER
 * signature verification has already succeeded (no processing ever happens
 * before that — enforced entirely by the controller, unchanged). Takes the
 * already-verified, parsed webhook body.
 *
 * Never credits/debits a provider's balance, never touches held-funds
 * accounting, never creates a new PayoutAttempt row or a new withdrawal
 * request, and never re-sends a payout — the only side effects here
 * are this file's own PaypalWebhookEvent bookkeeping and, via
 * payoutService.reconcilePayoutAttempt(), the same already-hardened P3-C
 * primitives every other reconciliation path already uses.
 */
export async function processPayoutWebhookEvent(webhookEvent: unknown): Promise<PayoutWebhookProcessResult> {
	const event = (webhookEvent && typeof webhookEvent === 'object' ? webhookEvent : {}) as Record<string, unknown>;

	const paypalEventId = readSafeString(event.id);
	const eventType = readSafeString(event.event_type);
	if (!paypalEventId || !eventType) {
		// Malformed signed payload — signature verified, but there is no
		// usable dedup key. Never processed, never persisted.
		return { httpStatus: 400 };
	}

	const resourceType = readSafeString(event.resource_type);
	const paypalCreateTime = parseSafeDate(event.create_time);
	const identifiers = extractPayoutWebhookIdentifiers(event.resource);
	const rawEvent = buildSanitizedRawEvent(identifiers);

	const claim = await claimOrStandDown({ paypalEventId, eventType, resourceType, paypalCreateTime, rawEvent });
	if (claim.outcome === 'STAND_DOWN') {
		return { httpStatus: 200 };
	}

	const correlated = await correlatePayoutAttempt(identifiers);
	if (!correlated) {
		await markEventFailed(claim.eventRowId);
		return { httpStatus: 200 };
	}

	try {
		// Authoritative financial processing remains ENTIRELY inside P3-C's
		// reconcilePayoutAttempt() — this file never inspects, branches on,
		// or persists its returned outcome value beyond "did it return
		// normally". No status state machine of any kind exists here.
		await payoutService.reconcilePayoutAttempt(correlated.attemptId);
		await markEventProcessed(claim.eventRowId, correlated.attemptId);
		return { httpStatus: 200 };
	} catch (error) {
		logger.error(`payout-webhook: reconcilePayoutAttempt(${correlated.attemptId}) threw unexpectedly for PaypalWebhookEvent ${claim.eventRowId} (paypalEventId=${paypalEventId}): ${error instanceof Error ? error.message : String(error)}`);
		await markEventFailed(claim.eventRowId, correlated.attemptId);
		return { httpStatus: 500 };
	}
}

export const payoutWebhookService = { processPayoutWebhookEvent };
