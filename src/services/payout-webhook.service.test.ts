import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';

// Payout P3-D: durable webhook-event dedup/claim/reclaim, narrow
// correlation, and delegation to the existing, already-hardened P3-C
// reconcilePayoutAttempt() — see payout-webhook.service.ts's own top
// comment. This file follows the same in-memory-array mock convention
// already established by payout.service.test.ts, but needs no
// $transaction wrapper at all: every call this service makes is a single,
// independent statement (never a transaction held across a network call —
// exactly the P3-D concurrency review's own requirement).

const ABANDONMENT_TIMEOUT_MS = 5 * 60 * 1000;

function makeP2002(target: string) {
	return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (\`${target}\`)`, {
		code: 'P2002', clientVersion: 'test', meta: { target: [target] }
	});
}

function createMockPrisma(t: TestContext, opts: { events?: any[]; attempts?: any[] } = {}) {
	const events: any[] = (opts.events || []).map(e => ({ ...e }));
	const attempts: any[] = (opts.attempts || []).map(a => ({ ...a }));
	let nextEventId = 1;

	const create = t.mock.fn(async (args: any) => {
		if (events.some(e => e.paypalEventId === args.data.paypalEventId)) {
			throw makeP2002('paypalEventId');
		}
		const row = {
			id: `evt-${nextEventId++}`,
			status: 'RECEIVED',
			payoutAttemptId: null,
			processedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			...args.data
		};
		events.push(row);
		return row;
	});

	const findUniqueEvent = t.mock.fn(async (args: any) => events.find(e => e.paypalEventId === args.where.paypalEventId) ?? null);

	const updateManyEvent = t.mock.fn(async (args: any) => {
		const matches = events.filter(e => Object.entries(args.where).every(([k, v]) => {
			if (k === 'updatedAt') return e.updatedAt.getTime() === (v as Date).getTime();
			return e[k] === v;
		}));
		matches.forEach(e => Object.assign(e, args.data));
		return { count: matches.length };
	});

	// correlatePayoutAttempt() always queries a single flat field
	// (payoutItemId / payoutBatchId / senderBatchId) — a generic single-key
	// matcher is all either findUnique or findMany here ever needs.
	const findUniqueAttempt = t.mock.fn(async (args: any) => {
		const [key, value] = Object.entries(args.where)[0];
		return attempts.find(a => a[key] === value) ?? null;
	});
	const findManyAttempt = t.mock.fn(async (args: any) => {
		const [key, value] = Object.entries(args.where)[0];
		return attempts.filter(a => a[key] === value);
	});

	return {
		events, attempts,
		paypalWebhookEvent: { create, findUnique: findUniqueEvent, updateMany: updateManyEvent },
		payoutAttempt: { findUnique: findUniqueAttempt, findMany: findManyAttempt }
	};
}

function mockDeps(t: TestContext, opts: { events?: any[]; attempts?: any[]; reconcileImpl?: any } = {}) {
	const mockPrisma = createMockPrisma(t, opts);
	t.mock.module('../config/db', { namedExports: { prisma: mockPrisma } });

	const reconcileSpy = t.mock.fn(opts.reconcileImpl || (async () => ({ outcome: 'COMPLETED', localStatus: 'COMPLETED' })));
	t.mock.module('./payout.service', { namedExports: { payoutService: { reconcilePayoutAttempt: reconcileSpy } } });

	return { ...mockPrisma, reconcileSpy };
}

async function loadService(t: TestContext) {
	const moduleUrl = `./payout-webhook.service.ts?fixture=${Date.now()}-${Math.random()}`;
	return await import(moduleUrl);
}

function makeWebhookEvent(overrides: any = {}) {
	return {
		id: 'WH-EVT-1',
		event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
		resource_type: 'payouts_item',
		create_time: '2026-01-01T00:00:00Z',
		resource: { payout_item_id: 'ITEM-1', payout_batch_id: 'BATCH-1' },
		...overrides
	};
}

// ── Malformed payload ──

test('processPayoutWebhookEvent: missing event id returns 400, never persists, never reconciles', async (t) => {
	const { events, reconcileSpy } = mockDeps(t);
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent({ id: undefined }));

	assert.equal(result.httpStatus, 400);
	assert.equal(events.length, 0);
	assert.equal(reconcileSpy.mock.callCount(), 0);
});

test('processPayoutWebhookEvent: missing event_type returns 400, never persists, never reconciles', async (t) => {
	const { events, reconcileSpy } = mockDeps(t);
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent({ event_type: undefined }));

	assert.equal(result.httpStatus, 400);
	assert.equal(events.length, 0);
	assert.equal(reconcileSpy.mock.callCount(), 0);
});

// ── First receipt / claim ──

test('processPayoutWebhookEvent: first receipt of a new event claims it, correlates, reconciles, and marks PROCESSED', async (t) => {
	const { events, reconcileSpy } = mockDeps(t, { attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }] });
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 1);
	assert.equal(reconcileSpy.mock.calls[0].arguments[0], 'attempt-1');
	assert.equal(events.length, 1);
	assert.equal(events[0].status, 'PROCESSED');
	assert.equal(events[0].payoutAttemptId, 'attempt-1');
	assert.ok(events[0].processedAt instanceof Date);
});

// ── Duplicate: already PROCESSED ──

test('processPayoutWebhookEvent: a duplicate of an already-PROCESSED event stands down — no reconciliation, HTTP 200', async (t) => {
	const oldUpdatedAt = new Date(Date.now() - 60_000);
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'PROCESSED', updatedAt: oldUpdatedAt, createdAt: oldUpdatedAt, payoutAttemptId: 'attempt-1' }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 0);
	assert.equal(events.length, 1, 'no second event row created');
	assert.equal(events[0].status, 'PROCESSED');
});

// ── Duplicate: fresh RECEIVED / FAILED ──

test('processPayoutWebhookEvent: a FRESH duplicate finding RECEIVED (within the abandonment window) stands down — no reconciliation', async (t) => {
	const recentUpdatedAt = new Date(Date.now() - 1000); // 1s old — well within the 5-minute window
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'RECEIVED', updatedAt: recentUpdatedAt, createdAt: recentUpdatedAt }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 0);
	assert.equal(events[0].status, 'RECEIVED', 'not reclaimed — still owned by whoever holds it');
	assert.equal(events[0].updatedAt.getTime(), recentUpdatedAt.getTime(), 'untouched');
});

test('processPayoutWebhookEvent: a FRESH duplicate finding FAILED (within the abandonment window) stands down — no reconciliation', async (t) => {
	const recentUpdatedAt = new Date(Date.now() - 1000);
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'FAILED', updatedAt: recentUpdatedAt, createdAt: recentUpdatedAt }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 0);
	assert.equal(events[0].status, 'FAILED');
});

// ── Stale reclaim ──

test('processPayoutWebhookEvent: a STALE RECEIVED row (>= 5 minutes untouched) is reclaimed and processed, and updatedAt genuinely advances', async (t) => {
	const staleUpdatedAt = new Date(Date.now() - (ABANDONMENT_TIMEOUT_MS + 1000));
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'RECEIVED', updatedAt: staleUpdatedAt, createdAt: staleUpdatedAt }],
		attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 1, 'the reclaiming worker proceeds to reconciliation');
	assert.equal(events.length, 1, 'reclaims the SAME row — never a second one');
	assert.equal(events[0].status, 'PROCESSED');
	assert.ok(events[0].updatedAt.getTime() > staleUpdatedAt.getTime(), 'updatedAt must genuinely advance on reclaim');
});

test('processPayoutWebhookEvent: a STALE FAILED row (>= 5 minutes untouched) is reclaimed and retried', async (t) => {
	const staleUpdatedAt = new Date(Date.now() - (ABANDONMENT_TIMEOUT_MS + 1000));
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'FAILED', updatedAt: staleUpdatedAt, createdAt: staleUpdatedAt }],
		attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 1);
	assert.equal(events[0].status, 'PROCESSED');
	assert.ok(events[0].updatedAt.getTime() > staleUpdatedAt.getTime());
});

test('processPayoutWebhookEvent: a future-dated updatedAt (clock skew) is never reclaimed — stands down conservatively, zero financial transition', async (t) => {
	const futureUpdatedAt = new Date(Date.now() + 60_000);
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'RECEIVED', updatedAt: futureUpdatedAt, createdAt: futureUpdatedAt }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 0);
	assert.equal(events[0].status, 'RECEIVED');
	assert.equal(events[0].updatedAt.getTime(), futureUpdatedAt.getTime(), 'never rewritten');
});

test('processPayoutWebhookEvent: two simultaneous stale-reclaim attempts — exactly one wins, the other stands down, reconciliation runs exactly once', async (t) => {
	const staleUpdatedAt = new Date(Date.now() - (ABANDONMENT_TIMEOUT_MS + 1000));
	const { events, reconcileSpy } = mockDeps(t, {
		events: [{ paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'RECEIVED', updatedAt: staleUpdatedAt, createdAt: staleUpdatedAt }],
		attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const [r1, r2] = await Promise.all([
		processPayoutWebhookEvent(makeWebhookEvent()),
		processPayoutWebhookEvent(makeWebhookEvent())
	]);

	assert.equal(r1.httpStatus, 200);
	assert.equal(r2.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 1, 'exactly one winner ever reaches reconciliation — no duplicate financial transition');
	assert.equal(events.length, 1);
	assert.equal(events[0].status, 'PROCESSED');
});

// ── Correlation hierarchy ──

test('correlatePayoutAttempt: exact payoutItemId match correlates to that attempt', async (t) => {
	mockDeps(t, { attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }] });
	const { correlatePayoutAttempt } = await loadService(t);

	const result = await correlatePayoutAttempt({ payoutItemId: 'ITEM-1' });
	assert.deepEqual(result, { attemptId: 'attempt-1' });
});

test('correlatePayoutAttempt: exactly one payoutBatchId match correlates to that attempt', async (t) => {
	mockDeps(t, { attempts: [{ id: 'attempt-1', payoutItemId: null, payoutBatchId: 'BATCH-1' }] });
	const { correlatePayoutAttempt } = await loadService(t);

	const result = await correlatePayoutAttempt({ payoutBatchId: 'BATCH-1' });
	assert.deepEqual(result, { attemptId: 'attempt-1' });
});

test('correlatePayoutAttempt: an AMBIGUOUS payoutBatchId (multiple attempts) never correlates', async (t) => {
	mockDeps(t, {
		attempts: [
			{ id: 'attempt-1', payoutItemId: null, payoutBatchId: 'BATCH-1' },
			{ id: 'attempt-2', payoutItemId: null, payoutBatchId: 'BATCH-1' }
		]
	});
	const { correlatePayoutAttempt } = await loadService(t);

	const result = await correlatePayoutAttempt({ payoutBatchId: 'BATCH-1' });
	assert.equal(result, null);
});

test('correlatePayoutAttempt: senderBatchId tier correlates correctly WHEN an identifier is supplied (logic is implemented and ready)', async (t) => {
	mockDeps(t, { attempts: [{ id: 'attempt-1', payoutItemId: null, payoutBatchId: null, senderBatchId: 'SBID-1' }] });
	const { correlatePayoutAttempt } = await loadService(t);

	const result = await correlatePayoutAttempt({ senderBatchId: 'SBID-1' });
	assert.deepEqual(result, { attemptId: 'attempt-1' });
});

test('extractPayoutWebhookIdentifiers: NEVER extracts senderBatchId, even from a resource that includes a sender_batch_id-shaped field — unverified Sandbox field, deliberately not read', async (t) => {
	mockDeps(t);
	const { extractPayoutWebhookIdentifiers } = await loadService(t);

	const identifiers = extractPayoutWebhookIdentifiers({ payout_item_id: 'ITEM-1', payout_batch_id: 'BATCH-1', sender_batch_id: 'SBID-1' });
	assert.equal(identifiers.payoutItemId, 'ITEM-1');
	assert.equal(identifiers.payoutBatchId, 'BATCH-1');
	assert.equal(identifiers.senderBatchId, undefined, 'senderBatchId extraction is a reported Sandbox-characterization blocker, not implemented');
});

test('processPayoutWebhookEvent: zero usable identifiers on the resource — no correlation, event persisted FAILED, no reconciliation, HTTP 200', async (t) => {
	const { events, reconcileSpy } = mockDeps(t);
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent({ resource: { some_unrelated_field: 'x' } }));

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 0);
	assert.equal(events[0].status, 'FAILED');
	assert.equal(events[0].payoutAttemptId, null);
});

test('processPayoutWebhookEvent: a payoutBatchId with zero matching attempts — no correlation, event persisted FAILED', async (t) => {
	const { events, reconcileSpy } = mockDeps(t, { attempts: [] });
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent({ resource: { payout_batch_id: 'BATCH-UNKNOWN' } }));

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 0);
	assert.equal(events[0].status, 'FAILED');
});

// ── Reconciliation outcome pass-through (delegation, not re-implementation) ──

for (const outcome of ['COMPLETED', 'FAILED', 'REVERSED', 'STILL_PROCESSING', 'ACTION_REQUIRED', 'ADMIN_REVIEW', 'UNKNOWN', 'RECOVERY_WINDOW_EXPIRED']) {
	test(`processPayoutWebhookEvent: a normal reconciliation outcome of ${outcome} always marks the event PROCESSED and acks 200 — the webhook layer never branches on the specific outcome value`, async (t) => {
		const { events } = mockDeps(t, {
			attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }],
			reconcileImpl: async () => ({ outcome, attemptId: 'attempt-1', withdrawalId: 'wd-1', message: 'x', localStatus: 'PENDING' })
		});
		const { processPayoutWebhookEvent } = await loadService(t);

		const result = await processPayoutWebhookEvent(makeWebhookEvent());

		assert.equal(result.httpStatus, 200);
		assert.equal(events[0].status, 'PROCESSED');
		assert.equal(events[0].payoutAttemptId, 'attempt-1');
	});
}

test('processPayoutWebhookEvent: reconcilePayoutAttempt() throwing an unexpected error marks the event FAILED (preserving the known payoutAttemptId) and returns 5xx — never a raw error leaked', async (t) => {
	const { events } = mockDeps(t, {
		attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }],
		reconcileImpl: async () => { throw new Error('boom: unexpected DB outage'); }
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 500);
	assert.equal(events[0].status, 'FAILED');
	assert.equal(events[0].payoutAttemptId, 'attempt-1', 'preserved even though processing ultimately failed');
});

// ── Crash / retry semantics: two independent calls model "first worker
// crashed after INSERT, a later redelivery resumes" ──

test('crash/retry semantics: a row abandoned right after insert (never reaches PROCESSED) is later reclaimed and completed by a redelivered event', async (t) => {
	const { events, reconcileSpy, paypalWebhookEvent } = mockDeps(t, {
		attempts: [{ id: 'attempt-1', payoutItemId: 'ITEM-1', payoutBatchId: 'BATCH-1' }]
	});
	const { processPayoutWebhookEvent } = await loadService(t);

	// Simulate the "first worker" claiming the row and then crashing before
	// ever reaching reconciliation — model this directly by inserting the
	// row and back-dating its updatedAt past the abandonment threshold,
	// exactly as a genuinely stuck RECEIVED row would look days later.
	const created = await paypalWebhookEvent.create({ data: { paypalEventId: 'WH-EVT-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'RECEIVED' } });
	created.updatedAt = new Date(Date.now() - (ABANDONMENT_TIMEOUT_MS + 5000));

	const result = await processPayoutWebhookEvent(makeWebhookEvent());

	assert.equal(result.httpStatus, 200);
	assert.equal(reconcileSpy.mock.callCount(), 1);
	assert.equal(events.length, 1, 'the SAME durable row is reused — never a duplicate PayoutAttempt/event');
	assert.equal(events[0].status, 'PROCESSED');
});

// ── Structural side-effect prohibitions (static-source regression guard,
// matching this codebase's existing admin-withdrawals.routes.test.ts
// convention) ──

test('payout-webhook.service.ts never creates a WalletTransaction, mutates Escrow, sends/resends a payout, or creates a new PayoutAttempt/Withdrawal', () => {
	const source = fs.readFileSync(path.join(__dirname, 'payout-webhook.service.ts'), 'utf8');
	assert.doesNotMatch(source, /walletTransaction/i);
	assert.doesNotMatch(source, /escrow/i);
	assert.doesNotMatch(source, /\.sendPayout\(/);
	assert.doesNotMatch(source, /\.initializeSendPayout\(/);
	assert.doesNotMatch(source, /payoutAttempt\.create\(/);
	assert.doesNotMatch(source, /\.withdrawal\.create\(/);
	assert.doesNotMatch(source, /markAttemptReversed|markAttemptCompleted|markAttemptDefinitelyFailed|markAttemptAccepted/, 'must delegate exclusively through reconcilePayoutAttempt() — never call P3-C\'s own primitives directly');
});
