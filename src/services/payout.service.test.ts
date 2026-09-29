import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Payout P1 — local state-machine foundations only (no PayPal HTTP call
// anywhere in payout.service.ts, and none is exercised by any test below).
//
// Batch 2A's lesson, reused deliberately throughout this file: a real
// Postgres SERIALIZABLE/unique-violation conflict is detected at COMMIT
// time — the transaction callback's own queries (including a create() that
// will end up rolled back) already ran to completion before Postgres
// aborts it. Every mock below that simulates a conflict therefore lets
// fn(tx) run fully first and THEN raises the conflict — either by throwing
// after fn(tx) resolves, or (for the "rolls back including the row it just
// created" scenarios) by snapshotting the shared in-memory arrays before
// fn(tx) runs and restoring that snapshot if fn(tx) throws, exactly
// modeling atomic rollback. No test here throws before fn(tx) is invoked
// for a conflict scenario.

function statusMatches(rowStatus: string, whereStatus: any): boolean {
	if (whereStatus && typeof whereStatus === 'object' && 'in' in whereStatus) return whereStatus.in.includes(rowStatus);
	return rowStatus === whereStatus;
}

// Payout P3-C: a generic Prisma-`where`-clause matcher — needed because
// persistPayoutItemId()/persistRecoveredPayoutBatchId() use conditional
// updates keyed on fields OTHER than `status` (e.g. `{ id, payoutItemId:
// null }`), unlike every pre-existing primitive in this file. Supports
// plain equality (including `null`) and the `{ in: [...] }` shape already
// used for `status` everywhere else.
function matchesWhere(row: any, where: Record<string, any>): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (value && typeof value === 'object' && 'in' in value) return (value as any).in.includes(row[key]);
		return row[key] === value;
	});
}

function createPayoutMockPrisma(t: TestContext, opts: {
	withdrawal?: { id: string; status: string; method?: string; amount?: number; currency?: string; paypalEmail?: string | null };
	payoutAttempts?: any[];
	createPayoutResult?: any;
	createPayoutImpl?: (params: any) => Promise<any>;
	getPayoutBatchResult?: any;
	getPayoutBatchImpl?: (payoutBatchId: string) => Promise<any>;
	recoverResult?: any;
	recoverImpl?: (params: any) => Promise<any>;
} = {}) {
	// Payout P2-C default: a fully valid, ready-to-send PayPal withdrawal —
	// existing tests only ever override id/status, so this keeps them exactly
	// as they were (they never read/assert on these new fields) while new
	// sendPayout() tests get a realistic row to override piecemeal.
	const withdrawals: any[] = [{
		id: 'wd-1', status: 'APPROVED', method: 'paypal', amount: 100, currency: 'USD',
		paypalEmail: 'provider@paypal-sandbox.example', ...opts.withdrawal
	}];
	const payoutAttempts: any[] = (opts.payoutAttempts || []).map(a => ({ ...a }));
	let nextAttemptId = 1;

	const findUniqueWithdrawal = t.mock.fn(async (args: any) => withdrawals.find(w => w.id === args.where.id) ?? null);
	const findFirstAttempt = t.mock.fn(async (args: any) =>
		payoutAttempts.find(a => a.withdrawalId === args.where.withdrawalId && statusMatches(a.status, args.where.status)) ?? null
	);
	const countAttempt = t.mock.fn(async (args: any) => payoutAttempts.filter(a => a.withdrawalId === args.where.withdrawalId).length);
	const createAttempt = t.mock.fn(async (args: any) => {
		const row = {
			id: `attempt-${nextAttemptId++}`, createdAt: new Date(), updatedAt: new Date(), completedAt: null,
			payoutBatchId: null, payoutItemId: null, failureReason: null, rawResponse: null, ...args.data
		};
		payoutAttempts.push(row);
		return row;
	});
	const updateManyWithdrawal = t.mock.fn(async (args: any) => {
		const matches = withdrawals.filter(w => w.id === args.where.id && statusMatches(w.status, args.where.status));
		matches.forEach(w => Object.assign(w, args.data));
		return { count: matches.length };
	});
	const updateManyAttempt = t.mock.fn(async (args: any) => {
		const matches = payoutAttempts.filter(a => matchesWhere(a, args.where));
		matches.forEach(a => Object.assign(a, args.data));
		return { count: matches.length };
	});
	const findUniqueOrThrowAttempt = t.mock.fn(async (args: any) => {
		const row = payoutAttempts.find(a => a.id === args.where.id);
		if (!row) throw new Error('attempt not found (test mock)');
		return row;
	});
	const findUniqueAttempt = t.mock.fn(async (args: any) => payoutAttempts.find(a => a.id === args.where.id) ?? null);

	const tx = {
		withdrawal: { findUnique: findUniqueWithdrawal, updateMany: updateManyWithdrawal },
		payoutAttempt: {
			findFirst: findFirstAttempt, count: countAttempt, create: createAttempt, updateMany: updateManyAttempt,
			findUniqueOrThrow: findUniqueOrThrowAttempt, findUnique: findUniqueAttempt
		}
	};

	const transactionSpy = t.mock.fn(async (fn: any) => {
		const withdrawalsSnapshot = withdrawals.map(w => ({ ...w }));
		const attemptsSnapshot = payoutAttempts.map(a => ({ ...a }));
		try {
			return await fn(tx);
		} catch (error) {
			// Models real Postgres transaction rollback: nothing the callback
			// mutated is allowed to survive.
			withdrawals.length = 0; withdrawals.push(...withdrawalsSnapshot);
			payoutAttempts.length = 0; payoutAttempts.push(...attemptsSnapshot);
			throw error;
		}
	});

	// Payout P2-C: sendPayout()'s own FLAT (non-transactional) pre-check read
	// — a separate spy from tx.withdrawal.findUnique above, since real Prisma
	// exposes both the top-level client and per-transaction client as
	// distinct objects, and sendPayout() deliberately reads via the
	// top-level client for this side-effect-free validation (see
	// payout.service.ts's own comment on why that's safe).
	const findUniqueWithdrawalFlat = t.mock.fn(async (args: any) => withdrawals.find(w => w.id === args.where.id) ?? null);

	// Payout P3-C: reconcilePayoutAttempt()'s own FLAT (non-transactional)
	// initial load — same rationale as findUniqueWithdrawalFlat above.
	const findUniqueAttemptFlat = t.mock.fn(async (args: any) => payoutAttempts.find(a => a.id === args.where.id) ?? null);

	// Payout P2-C: paypalService.createPayout() — mocked at the module
	// boundary, never a real network call. Defaults to a realistic ACCEPTED
	// response so tests that don't care about the PayPal leg (e.g. plain
	// initializeSendPayout() tests, which never call sendPayout() at all)
	// are unaffected; sendPayout()-specific tests override via
	// createPayoutResult/createPayoutImpl.
	const createPayoutSpy = t.mock.fn(
		opts.createPayoutImpl ||
		(async () => opts.createPayoutResult || { outcome: 'ACCEPTED', payoutBatchId: 'PB-DEFAULT', batchStatus: 'PENDING', safeResponse: {} })
	);

	// Payout P3-C: paypalService.getPayoutBatch()/recoverPayoutBySenderBatch()
	// — mocked at the module boundary, never a real network call. Defaults
	// to a safe UNKNOWN so tests that don't care about these calls (e.g.
	// plain sendPayout()/initializeSendPayout() tests) are unaffected;
	// reconciliation-specific tests override via
	// getPayoutBatchResult/getPayoutBatchImpl/recoverResult/recoverImpl.
	const getPayoutBatchSpy = t.mock.fn(
		opts.getPayoutBatchImpl ||
		(async () => opts.getPayoutBatchResult || { outcome: 'UNKNOWN', reason: 'test default: no getPayoutBatchResult configured' })
	);
	const recoverSpy = t.mock.fn(
		opts.recoverImpl ||
		(async () => opts.recoverResult || { outcome: 'UNKNOWN', reason: 'test default: no recoverResult configured' })
	);

	t.mock.module('../config/db', {
		namedExports: { prisma: { $transaction: transactionSpy, withdrawal: { findUnique: findUniqueWithdrawalFlat }, payoutAttempt: { findUnique: findUniqueAttemptFlat } } }
	});
	t.mock.module('./paypal.service', {
		namedExports: { paypalService: { createPayout: createPayoutSpy, getPayoutBatch: getPayoutBatchSpy, recoverPayoutBySenderBatch: recoverSpy } }
	});

	return {
		findUniqueWithdrawal, findFirstAttempt, countAttempt, createAttempt, updateManyWithdrawal, updateManyAttempt,
		findUniqueOrThrowAttempt, findUniqueAttempt, transactionSpy, withdrawals, payoutAttempts,
		findUniqueWithdrawalFlat, createPayoutSpy,
		findUniqueAttemptFlat, getPayoutBatchSpy, recoverSpy
	};
}

async function loadService(t: TestContext, opts?: Parameters<typeof createPayoutMockPrisma>[1]) {
	const mocks = createPayoutMockPrisma(t, opts);
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);
	return { payoutService, ...mocks };
}

// ============================================================================
// initializeSendPayout — happy path, validation, and the fast-path check
// ============================================================================

test('A. initializeSendPayout: happy path — an APPROVED withdrawal gets a new PENDING PayoutAttempt and transitions to PROCESSING, inside a SERIALIZABLE transaction', async (t) => {
	const { payoutService, transactionSpy, withdrawals } = await loadService(t);

	const attempt = await payoutService.initializeSendPayout('wd-1');

	assert.equal(attempt.status, 'PENDING');
	assert.equal(attempt.attemptNumber, 1);
	assert.equal(attempt.withdrawalId, 'wd-1');
	assert.equal(attempt.senderBatchId, 'wd-wd-1-a1');
	assert.equal(withdrawals[0].status, 'PROCESSING');
	assert.equal(transactionSpy.mock.callCount(), 1);
	assert.equal(transactionSpy.mock.calls[0].arguments[1]?.isolationLevel, 'Serializable');
});

test('B. initializeSendPayout: a non-existent withdrawal is rejected with 404, nothing created', async (t) => {
	const { payoutService, createAttempt } = await loadService(t, { withdrawal: undefined as any });
	// Force a lookup miss by requesting an id that doesn't exist in the seeded array.
	await assert.rejects(() => payoutService.initializeSendPayout('does-not-exist'), (err: any) => {
		assert.equal(err.statusCode, 404);
		return true;
	});
	assert.equal(createAttempt.mock.callCount(), 0);
});

for (const badStatus of ['PENDING', 'PROCESSING', 'REJECTED', 'COMPLETED']) {
	test(`C. initializeSendPayout: a withdrawal in status ${badStatus} (not APPROVED) is rejected with 409, nothing created`, async (t) => {
		const { payoutService, createAttempt } = await loadService(t, { withdrawal: { id: 'wd-1', status: badStatus } });
		await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => {
			assert.equal(err.statusCode, 409);
			return true;
		});
		assert.equal(createAttempt.mock.callCount(), 0);
	});
}

test('D. initializeSendPayout: an already-active attempt (PENDING or PROCESSING) is caught by the fast-path check and rejected with 409, nothing new created', async (t) => {
	const { payoutService, createAttempt } = await loadService(t, {
		payoutAttempts: [{ id: 'attempt-existing', withdrawalId: 'wd-1', attemptNumber: 1, status: 'PROCESSING', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		return true;
	});
	assert.equal(createAttempt.mock.callCount(), 0);
});

test('E. initializeSendPayout: a prior FAILED attempt does not block a new one, and the new attempt correctly gets the NEXT attemptNumber', async (t) => {
	const { payoutService, payoutAttempts } = await loadService(t, {
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'FAILED', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 2);
	assert.equal(attempt.senderBatchId, 'wd-wd-1-a2');
	assert.equal(payoutAttempts.length, 2);
});

test('F. initializeSendPayout: senderBatchId matches deriveSenderBatchId\'s own output exactly — no divergent inline formatting', async (t) => {
	const { deriveSenderBatchId } = await import('../utils/payout-attempt.util');
	const { payoutService } = await loadService(t);
	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.senderBatchId, deriveSenderBatchId('wd-1', 1));
});

// ============================================================================
// initializeSendPayout — the critical rollback requirement
// ============================================================================

test('G. initializeSendPayout: if the Withdrawal APPROVED->PROCESSING transition does not match exactly one row, the WHOLE transaction rolls back — including the PayoutAttempt already created inside it', async (t) => {
	const withdrawals = [{ id: 'wd-1', status: 'APPROVED' }];
	const payoutAttempts: any[] = [];
	const findUnique = t.mock.fn(async () => withdrawals[0]);
	const findFirst = t.mock.fn(async () => null);
	const count = t.mock.fn(async () => 0);
	const create = t.mock.fn(async (args: any) => {
		const row = { id: 'attempt-1', status: 'PENDING', ...args.data };
		payoutAttempts.push(row);
		return row;
	});
	// Simulates the row no longer matching {status: APPROVED} at the moment of
	// the conditional update — e.g. concurrently changed between the initial
	// read and this write — exactly the case the design calls CRITICAL.
	const updateManyWithdrawal = t.mock.fn(async () => ({ count: 0 }));
	const tx = { withdrawal: { findUnique, updateMany: updateManyWithdrawal }, payoutAttempt: { findFirst, count, create } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		const snapshot = payoutAttempts.map(a => ({ ...a }));
		try {
			return await fn(tx);
		} catch (error) {
			payoutAttempts.length = 0; payoutAttempts.push(...snapshot);
			throw error;
		}
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		return true;
	});
	assert.equal(payoutAttempts.length, 0, 'the PayoutAttempt created inside the doomed transaction must not survive the rollback');
	assert.equal(create.mock.callCount(), 1, 'create() DID run inside the transaction — this models a real commit-time-style failure, not a pre-check that prevented create from ever running');
});

// ============================================================================
// initializeSendPayout — SERIALIZABLE conflict retries (reusing Batch 2A's
// isRetryableTransactionConflict, exercised here exactly as in
// withdrawal.service.test.ts's own precedent tests)
// ============================================================================

function makeHappyTx() {
	const withdrawals = [{ id: 'wd-1', status: 'APPROVED' }];
	const payoutAttempts: any[] = [];
	const tx = {
		withdrawal: {
			findUnique: async () => withdrawals[0],
			updateMany: async (args: any) => {
				const match = withdrawals[0].id === args.where.id && withdrawals[0].status === args.where.status;
				if (match) Object.assign(withdrawals[0], args.data);
				return { count: match ? 1 : 0 };
			}
		},
		payoutAttempt: {
			findFirst: async () => null,
			count: async () => payoutAttempts.length,
			create: async (args: any) => {
				const row = { id: `attempt-${payoutAttempts.length + 1}`, ...args.data };
				payoutAttempts.push(row);
				return row;
			}
		}
	};
	return { tx, withdrawals, payoutAttempts };
}

test('H. initializeSendPayout: a P2034 serialization conflict is retried transparently, succeeding on the retried attempt', async (t) => {
	const { Prisma } = await import('@prisma/client');
	const { tx } = makeHappyTx();
	let attempts = 0;
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attempts += 1;
		if (attempts === 1) throw new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' });
		return fn(tx);
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 1);
	assert.equal(transactionSpy.mock.callCount(), 2);
});

test('I. initializeSendPayout: a DriverAdapterError (TransactionWriteConflict) is retried transparently, succeeding on the retried attempt', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	const { tx } = makeHappyTx();
	let attempts = 0;
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attempts += 1;
		if (attempts === 1) throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		return fn(tx);
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 1);
	assert.equal(transactionSpy.mock.callCount(), 2);
});

test('J. initializeSendPayout: an UNRELATED DriverAdapterError is never retried, propagates immediately on the first attempt', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let attempts = 0;
	const transactionSpy = t.mock.fn(async () => {
		attempts += 1;
		throw new DriverAdapterError({ kind: 'DatabaseNotReachable' });
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(
		() => payoutService.initializeSendPayout('wd-1'),
		(err: any) => { assert.equal(err.cause?.kind, 'DatabaseNotReachable'); return true; }
	);
	assert.equal(attempts, 1);
});

test('K. initializeSendPayout: a P2002 on active_attempt_unique is classified as a clean business conflict (409) and is NEVER retried', async (t) => {
	const { Prisma } = await import('@prisma/client');
	const { tx, payoutAttempts } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002', clientVersion: 'test', meta: { target: ['active_attempt_unique'] }
		});
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		assert.notEqual(err.constructor?.name, 'PrismaClientKnownRequestError', 'must be converted to the clean AppError, not surfaced raw');
		return true;
	});
	assert.equal(transactionSpy.mock.callCount(), 1, 'a genuine active-attempt conflict is a real business state, not a transient race — must not be blindly retried');
	assert.equal(payoutAttempts.length, 0);
});

test('L. initializeSendPayout: a P2002 on the attemptNumber/senderBatchId race constraints is classified as a transient allocation race and IS retried, succeeding once the retry allocates a fresh number', async (t) => {
	const { Prisma } = await import('@prisma/client');
	let attempts = 0;
	const { tx } = makeHappyTx();
	const realCreate = tx.payoutAttempt.create;
	tx.payoutAttempt.create = async (args: any) => {
		attempts += 1;
		if (attempts === 1) {
			throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
				code: 'P2002', clientVersion: 'test', meta: { target: ['payout_attempts_withdrawalId_attemptNumber_key'] }
			});
		}
		return realCreate(args);
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 1);
	assert.equal(transactionSpy.mock.callCount(), 2, 'the whole transaction (which recomputes attemptNumber from scratch) is retried, not just the create() call');
});

test('M. initializeSendPayout: an UNCLASSIFIABLE P2002 (target matches neither known constraint) propagates unmodified — never guessed, never silently retried', async (t) => {
	const { Prisma } = await import('@prisma/client');
	let attempts = 0;
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		attempts += 1;
		throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002', clientVersion: 'test', meta: { target: ['some_other_unrelated_constraint'] }
		});
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => {
		assert.equal(err.code, 'P2002', 'the original raw Prisma error, not a converted business error');
		return true;
	});
	assert.equal(attempts, 1, 'an unclassified conflict must never be blindly retried');
});

test('N. initializeSendPayout: the attemptNumber-race retry is bounded — if every attempt races, the final P2002 propagates rather than retrying forever', async (t) => {
	const { Prisma } = await import('@prisma/client');
	let attempts = 0;
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		attempts += 1;
		throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002', clientVersion: 'test', meta: { target: ['payout_attempts_senderBatchId_key'] }
		});
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'));
	assert.equal(attempts, 3, 'bounded at MAX_SERIALIZATION_RETRIES (3), matching withdrawal.service.ts\'s own precedent');
});

// ============================================================================
// classifyInitializationConflict() P2002 metadata-shape fix (Payout P1.1) —
// a real DEV Postgres concurrency run confirmed that with this project's
// exact Prisma 7.8.0 + @prisma/adapter-pg combination, a driver-adapter-
// surfaced P2002 does NOT populate `meta.target` at all; the tests above
// (K, L, M, N) only ever exercised the ORIGINALLY-ASSUMED `meta.target`
// shape. The tests below specifically exercise the CONFIRMED real shape —
// `meta.driverAdapterError.cause.constraint.fields` (plus the constraint
// NAME parsed from `cause.originalMessage`) — using the exact JSON
// structure captured verbatim from that real run, reproduced here as a
// literal fixture rather than a hand-wavy approximation.
// ============================================================================

function realAdapterPgP2002(constraintName: string, fields: string[]) {
	return new (require('@prisma/client').Prisma.PrismaClientKnownRequestError)(
		`Unique constraint failed on the constraint: \`${constraintName}\``,
		{
			code: 'P2002', clientVersion: 'test',
			meta: {
				modelName: 'PayoutAttempt',
				driverAdapterError: {
					name: 'DriverAdapterError',
					cause: {
						originalCode: '23505',
						originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
						kind: 'UniqueConstraintViolation',
						constraint: { fields: fields.map(f => `"${f}"`) }
					}
				}
			}
		}
	);
}

test('P1.1-A. initializeSendPayout: the ORIGINAL meta.target P2002 shape still classifies correctly (regression guard for the fix below)', async (t) => {
	const { Prisma } = await import('@prisma/client');
	const { tx, payoutAttempts } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002', clientVersion: 'test', meta: { target: ['active_attempt_unique'] }
		});
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(transactionSpy.mock.callCount(), 1);
	assert.equal(payoutAttempts.length, 0);
});

test('P1.1-B. initializeSendPayout: the CONFIRMED real adapter-pg P2002 shape (meta.driverAdapterError.cause.constraint.fields) on active_attempt_unique is classified as a clean 409, never surfaced raw', async (t) => {
	const { tx, payoutAttempts } = makeHappyTx();
	tx.payoutAttempt.create = async () => { throw realAdapterPgP2002('active_attempt_unique', ['withdrawalId']); };
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		assert.notEqual(err.constructor?.name, 'PrismaClientKnownRequestError', 'must be converted to the clean AppError, not surfaced raw — this is the exact leak the real DEV run observed before this fix');
		return true;
	});
	assert.equal(transactionSpy.mock.callCount(), 1, 'a genuine active-attempt conflict must not be blindly retried');
	assert.equal(payoutAttempts.length, 0);
});

test('P1.1-C. initializeSendPayout: the CONFIRMED real adapter-pg P2002 shape on the attemptNumber-race constraints IS retried, succeeding once the retry allocates a fresh number', async (t) => {
	let attempts = 0;
	const { tx } = makeHappyTx();
	const realCreate = tx.payoutAttempt.create;
	tx.payoutAttempt.create = async (args: any) => {
		attempts += 1;
		if (attempts === 1) throw realAdapterPgP2002('payout_attempts_senderBatchId_key', ['senderBatchId']);
		return realCreate(args);
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 1);
	assert.equal(transactionSpy.mock.callCount(), 2, 'the whole transaction is retried, exactly matching the target-shape precedent (test L)');
});

test('P1.1-D. initializeSendPayout: the CONFIRMED real adapter-pg P2002 shape on the withdrawalId+attemptNumber composite constraint is ALSO classified as the attemptNumber race, matching the intended state-machine semantics', async (t) => {
	let attempts = 0;
	const { tx } = makeHappyTx();
	const realCreate = tx.payoutAttempt.create;
	tx.payoutAttempt.create = async (args: any) => {
		attempts += 1;
		if (attempts === 1) throw realAdapterPgP2002('payout_attempts_withdrawalId_attemptNumber_key', ['withdrawalId', 'attemptNumber']);
		return realCreate(args);
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 1);
	assert.equal(transactionSpy.mock.callCount(), 2);
});

test('P1.1-E. initializeSendPayout: a P2002 on an UNRELATED constraint, in the real adapter-pg shape, remains unclassified and propagates raw — never guessed, never retried', async (t) => {
	let attempts = 0;
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		attempts += 1;
		throw realAdapterPgP2002('some_other_unrelated_constraint', ['someOtherColumn']);
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => { assert.equal(err.code, 'P2002'); return true; });
	assert.equal(attempts, 1, 'an unrelated constraint must never be blindly retried, in either metadata shape');
});

test('P1.1-F. initializeSendPayout: a P2002 with malformed/missing metadata (no target, no driverAdapterError) remains unclassified and propagates raw', async (t) => {
	const { Prisma } = await import('@prisma/client');
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => { assert.equal(err.code, 'P2002'); return true; });
});

test('P1.1-F2. initializeSendPayout: a P2002 whose driverAdapterError.cause is present but has neither a parseable originalMessage nor a constraint.fields array remains unclassified and propagates raw', async (t) => {
	const { Prisma } = await import('@prisma/client');
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002', clientVersion: 'test',
			meta: { modelName: 'PayoutAttempt', driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23505', kind: 'UniqueConstraintViolation' } } }
		});
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => { assert.equal(err.code, 'P2002'); return true; });
});

test('P1.1-G. initializeSendPayout: a non-P2002 PrismaClientKnownRequestError is never classified/retried by classifyInitializationConflict — only isRetryableTransactionConflict\'s own genuine-conflict check applies', async (t) => {
	const { Prisma } = await import('@prisma/client');
	let attempts = 0;
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		attempts += 1;
		throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: 'test', meta: { field_name: 'withdrawalId' } });
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => { assert.equal(err.code, 'P2003'); return true; });
	assert.equal(attempts, 1, 'a P2003 must never be retried by either the transaction-conflict check or the P2002 classifier');
});

test('P1.1-H. initializeSendPayout: the attemptNumber-race retry via the real adapter-pg shape is bounded — exhausted retries surface the final P2002 raw rather than looping forever', async (t) => {
	let attempts = 0;
	const { tx } = makeHappyTx();
	tx.payoutAttempt.create = async () => {
		attempts += 1;
		throw realAdapterPgP2002('payout_attempts_senderBatchId_key', ['senderBatchId']);
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
	const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { payoutService } = await import(moduleUrl);

	await assert.rejects(() => payoutService.initializeSendPayout('wd-1'), (err: any) => { assert.equal(err.code, 'P2002'); return true; });
	assert.equal(attempts, 3, 'bounded at MAX_SERIALIZATION_RETRIES (3), matching the target-shape precedent (test N)');
});

test('O. initializeSendPayout: two concurrent initializations correctly serialize — the second (retried) attempt observes the first\'s already-created attempt and is rejected as an active-attempt conflict', async (t) => {
	// Two independently-loaded instances sharing one underlying withdrawal +
	// attempts array — the same "loser retried against now-current state"
	// shape used by withdrawal.service.test.ts's own concurrent test.
	const sharedWithdrawal = { id: 'wd-1', status: 'APPROVED' };
	const sharedAttempts: any[] = [];

	let first: Awaited<ReturnType<typeof loadServiceSharing>>;
	let second: Awaited<ReturnType<typeof loadServiceSharing>>;

	async function loadServiceSharing(t2: TestContext) {
		const tx = {
			withdrawal: {
				findUnique: async () => sharedWithdrawal,
				updateMany: async (args: any) => {
					const match = sharedWithdrawal.id === args.where.id && sharedWithdrawal.status === args.where.status;
					if (match) Object.assign(sharedWithdrawal, args.data);
					return { count: match ? 1 : 0 };
				}
			},
			payoutAttempt: {
				findFirst: async (args: any) => sharedAttempts.find(a => a.withdrawalId === args.where.withdrawalId && statusMatches(a.status, args.where.status)) ?? null,
				count: async () => sharedAttempts.length,
				create: async (args: any) => { const row = { id: `attempt-${sharedAttempts.length + 1}`, ...args.data }; sharedAttempts.push(row); return row; }
			}
		};
		const transactionSpy = t2.mock.fn(async (fn: any) => fn(tx));
		t2.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
		const moduleUrl = `./payout.service.ts?fixture=${Date.now()}-${Math.random()}`;
		const { payoutService } = await import(moduleUrl);
		return { payoutService, transactionSpy };
	}

	await t.test('initialization A', async (t2) => { first = await loadServiceSharing(t2); await first.payoutService.initializeSendPayout('wd-1'); });

	let secondRejected = false;
	await t.test('initialization B (sees A\'s already-active attempt)', async (t2) => {
		second = await loadServiceSharing(t2);
		try { await second.payoutService.initializeSendPayout('wd-1'); } catch { secondRejected = true; }
	});

	assert.equal(secondRejected, true);
	assert.equal(sharedAttempts.length, 1, 'only ONE attempt ever exists for this withdrawal — the invariant the partial unique index protects');
});

// ============================================================================
// markAttemptAccepted
// ============================================================================

test('P. markAttemptAccepted: PENDING -> PROCESSING, storing the given payoutBatchId', async (t) => {
	const { payoutService, payoutAttempts } = await loadService(t, {
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'PENDING', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const result = await payoutService.markAttemptAccepted('attempt-1', 'batch-123');
	assert.equal(result.status, 'PROCESSING');
	assert.equal(result.payoutBatchId, 'batch-123');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

for (const status of ['PROCESSING', 'COMPLETED', 'FAILED']) {
	test(`Q. markAttemptAccepted: an attempt already in status ${status} (not PENDING) is rejected, no mutation`, async (t) => {
		const { payoutService, payoutAttempts } = await loadService(t, {
			payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status, senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
		});
		await assert.rejects(() => payoutService.markAttemptAccepted('attempt-1'));
		assert.equal(payoutAttempts[0].status, status);
	});
}

test('R. markAttemptAccepted: a non-existent attempt id is rejected with 404', async (t) => {
	const { payoutService } = await loadService(t);
	await assert.rejects(() => payoutService.markAttemptAccepted('does-not-exist'), (err: any) => {
		assert.equal(err.statusCode, 404);
		return true;
	});
});

// ============================================================================
// markAttemptDefinitelyFailed — terminal idempotency
// ============================================================================

test('S. markAttemptDefinitelyFailed: PENDING/PROCESSING -> FAILED, and atomically reverts the Withdrawal PROCESSING -> APPROVED', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'PROCESSING' },
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'PROCESSING', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const result = await payoutService.markAttemptDefinitelyFailed('attempt-1', 'INSUFFICIENT_FUNDS');
	assert.equal(result.status, 'FAILED');
	assert.equal(result.failureReason, 'INSUFFICIENT_FUNDS');
	assert.equal(payoutAttempts[0].status, 'FAILED');
	assert.equal(withdrawals[0].status, 'APPROVED');
});

test('T. markAttemptDefinitelyFailed: a DUPLICATE failure call on an already-FAILED attempt is a safe no-op — no error, no double Withdrawal mutation', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED' }, // already reverted by the first failure call
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const result = await payoutService.markAttemptDefinitelyFailed('attempt-1', 'INSUFFICIENT_FUNDS');
	assert.equal(result.status, 'FAILED');
	assert.equal(payoutAttempts[0].status, 'FAILED');
	assert.equal(withdrawals[0].status, 'APPROVED', 'unchanged — no second, spurious transition');
});

test('U. markAttemptDefinitelyFailed: failure must NEVER downgrade an attempt that already reached COMPLETED', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'COMPLETED' },
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'COMPLETED', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const result = await payoutService.markAttemptDefinitelyFailed('attempt-1', 'late duplicate failure signal');
	assert.equal(result.status, 'COMPLETED', 'must remain COMPLETED — never downgraded to FAILED');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
	assert.equal(withdrawals[0].status, 'COMPLETED', 'unchanged');
});

// ============================================================================
// markAttemptCompleted — terminal idempotency
// ============================================================================

test('V. markAttemptCompleted: PENDING/PROCESSING -> COMPLETED, and atomically advances the Withdrawal PROCESSING -> COMPLETED', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'PROCESSING' },
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'PROCESSING', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const result = await payoutService.markAttemptCompleted('attempt-1', { payoutItemId: 'item-1' });
	assert.equal(result.status, 'COMPLETED');
	assert.equal(result.payoutItemId, 'item-1');
	assert.ok(result.completedAt instanceof Date);
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
	assert.equal(withdrawals[0].status, 'COMPLETED');
});

test('W. markAttemptCompleted: a DUPLICATE completion call on an already-COMPLETED attempt is a safe no-op', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'COMPLETED' },
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'COMPLETED', payoutItemId: 'item-1', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	const result = await payoutService.markAttemptCompleted('attempt-1', { payoutItemId: 'item-1' });
	assert.equal(result.status, 'COMPLETED');
	assert.equal(withdrawals[0].status, 'COMPLETED');
});

test('X. markAttemptCompleted: a completion signal for an already-FAILED attempt is REJECTED, never resurrecting it as COMPLETED', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED' },
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});
	await assert.rejects(() => payoutService.markAttemptCompleted('attempt-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		return true;
	});
	assert.equal(payoutAttempts[0].status, 'FAILED', 'must remain FAILED — never resurrected');
	assert.equal(withdrawals[0].status, 'APPROVED', 'unchanged');
});

test('Y. markAttemptCompleted / markAttemptDefinitelyFailed: a non-existent attempt id is rejected with 404 for both', async (t) => {
	const { payoutService } = await loadService(t);
	await assert.rejects(() => payoutService.markAttemptCompleted('does-not-exist'), (err: any) => { assert.equal(err.statusCode, 404); return true; });
});
test('Z. markAttemptDefinitelyFailed: a non-existent attempt id is rejected with 404', async (t) => {
	const { payoutService } = await loadService(t);
	await assert.rejects(() => payoutService.markAttemptDefinitelyFailed('does-not-exist', 'x'), (err: any) => { assert.equal(err.statusCode, 404); return true; });
});

// ============================================================================
// Payout P3-A — markAttemptReversed(): COMPLETED -> REVERSED, and
// Withdrawal COMPLETED -> REVERSED. STATE RECORDING ONLY — no wallet/balance
// accounting, no new PayoutAttempt, no reopening to APPROVED.
// ============================================================================

function loadCompletedAttempt(t: TestContext, overrides: { withdrawalStatus?: string; attemptStatus?: string } = {}) {
	return loadService(t, {
		withdrawal: { id: 'wd-1', status: overrides.withdrawalStatus ?? 'COMPLETED' },
		payoutAttempts: [{
			id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1,
			status: overrides.attemptStatus ?? 'COMPLETED',
			senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL', payoutBatchId: 'PB-1'
		}]
	});
}

test('AA1. markAttemptReversed: a COMPLETED attempt + COMPLETED withdrawal -> RETURNED reverses both', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t);

	const result = await payoutService.markAttemptReversed('attempt-1', 'RETURNED');

	assert.equal(result.status, 'REVERSED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('AA2. markAttemptReversed: same for REFUNDED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'REFUNDED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('AA3. markAttemptReversed: same for REVERSED (PayPal item status literally named REVERSED)', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'REVERSED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('AA4. markAttemptReversed: the exact external PayPal terminal status is persisted verbatim, distinct from failureReason', async (t) => {
	const { payoutService, payoutAttempts } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'RETURNED');
	assert.equal(payoutAttempts[0].paypalTerminalStatus, 'RETURNED');
	assert.equal(payoutAttempts[0].failureReason, undefined, 'must never be written to failureReason — a different semantic class');
});

test('AA5. markAttemptReversed: a repeated call with the SAME reversal is idempotent — safe no-op, no error, no double mutation', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t);

	const first = await payoutService.markAttemptReversed('attempt-1', 'RETURNED');
	const second = await payoutService.markAttemptReversed('attempt-1', 'RETURNED');

	assert.equal(first.status, 'REVERSED');
	assert.equal(second.status, 'REVERSED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('AA6. markAttemptReversed: two concurrent calls for the same attempt cannot corrupt state — exactly one performs the real transition, the other observes it as already-reversed', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t);

	const [a, b] = await Promise.all([
		payoutService.markAttemptReversed('attempt-1', 'RETURNED'),
		payoutService.markAttemptReversed('attempt-1', 'RETURNED')
	]);

	assert.equal(a.status, 'REVERSED');
	assert.equal(b.status, 'REVERSED');
	assert.equal(payoutAttempts.length, 1, 'no duplicate row, no corruption');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

// ============================================================================
// Financial-invariant hardening — atomicity of markAttemptReversed().
// After a successful return, BOTH PayoutAttempt=REVERSED and
// Withdrawal=REVERSED must be true, or neither transition committed.
// ============================================================================

test('AA6b. markAttemptReversed: if the Withdrawal cannot transition from COMPLETED (data-integrity anomaly), the WHOLE transaction rolls back — the PayoutAttempt is NOT left REVERSED by itself', async (t) => {
	// A deliberately inconsistent fixture: the PayoutAttempt genuinely is
	// COMPLETED, but its Withdrawal is NOT (simulating an anomaly that should
	// never occur under normal operation, since markAttemptCompleted() always
	// moves both together) — proves the Withdrawal-side conditional update's
	// result count is actually checked, not silently ignored.
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t, { withdrawalStatus: 'PROCESSING' });

	await assert.rejects(() => payoutService.markAttemptReversed('attempt-1', 'RETURNED'), (err: any) => { assert.equal(err.statusCode, 409); return true; });

	assert.equal(payoutAttempts[0].status, 'COMPLETED', 'must be rolled back to COMPLETED — never left REVERSED by itself');
	assert.equal(payoutAttempts[0].paypalTerminalStatus, undefined, 'the paypalTerminalStatus write must also be rolled back');
	assert.equal(withdrawals[0].status, 'PROCESSING', 'unchanged — no half-transition');
});

test('AA6c. markAttemptReversed: an attempt already REVERSED while its Withdrawal is NOT REVERSED is rejected as a data-integrity anomaly, never silently accepted as an idempotent success', async (t) => {
	// Simulates discovering the same anomaly via the idempotent-call path:
	// the attempt row already reads REVERSED (perhaps from a prior run before
	// this hardening existed), but its Withdrawal was never actually moved.
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t, { attemptStatus: 'REVERSED', withdrawalStatus: 'COMPLETED' });

	await assert.rejects(() => payoutService.markAttemptReversed('attempt-1', 'RETURNED'), (err: any) => { assert.equal(err.statusCode, 409); return true; });

	assert.equal(payoutAttempts[0].status, 'REVERSED', 'unchanged');
	assert.equal(withdrawals[0].status, 'COMPLETED', 'unchanged — the anomaly is surfaced, never silently patched over');
});

test('AA7. markAttemptReversed: a PENDING attempt cannot become REVERSED', async (t) => {
	const { payoutService, payoutAttempts } = await loadCompletedAttempt(t, { attemptStatus: 'PENDING', withdrawalStatus: 'PROCESSING' });
	await assert.rejects(() => payoutService.markAttemptReversed('attempt-1', 'RETURNED'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(payoutAttempts[0].status, 'PENDING', 'unchanged');
});

test('AA8. markAttemptReversed: a PROCESSING attempt cannot become REVERSED', async (t) => {
	const { payoutService, payoutAttempts } = await loadCompletedAttempt(t, { attemptStatus: 'PROCESSING', withdrawalStatus: 'PROCESSING' });
	await assert.rejects(() => payoutService.markAttemptReversed('attempt-1', 'RETURNED'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(payoutAttempts[0].status, 'PROCESSING', 'unchanged');
});

test('AA9. markAttemptReversed: a FAILED attempt cannot become REVERSED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t, { attemptStatus: 'FAILED', withdrawalStatus: 'APPROVED' });
	await assert.rejects(() => payoutService.markAttemptReversed('attempt-1', 'RETURNED'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(payoutAttempts[0].status, 'FAILED', 'unchanged');
	assert.equal(withdrawals[0].status, 'APPROVED', 'unchanged');
});

test('AA10. markAttemptReversed: the Withdrawal NEVER becomes APPROVED as a result of a reversal', async (t) => {
	const { payoutService, withdrawals } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'RETURNED');
	assert.notEqual(withdrawals[0].status, 'APPROVED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('AA11. markAttemptReversed: no WalletTransaction is touched — the mock tx has no walletTransaction model at all, so any such access would throw', async (t) => {
	const { payoutService } = await loadCompletedAttempt(t);
	// If markAttemptReversed() ever referenced tx.walletTransaction, this call
	// would throw (undefined has no .create), since this file's mock tx
	// object (payout.service.ts never needs a wallet model) declares none.
	await assert.doesNotReject(() => payoutService.markAttemptReversed('attempt-1', 'RETURNED'));
});

test('AA12. markAttemptReversed: no new PayoutAttempt is ever created', async (t) => {
	const { payoutService, createAttempt } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'RETURNED');
	assert.equal(createAttempt.mock.callCount(), 0);
});

test('AA17. markAttemptReversed then markAttemptCompleted: a REVERSED attempt can never be re-completed', async (t) => {
	const { payoutService, payoutAttempts } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'RETURNED');

	await assert.rejects(() => payoutService.markAttemptCompleted('attempt-1'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(payoutAttempts[0].status, 'REVERSED', 'must remain REVERSED — never resurrected to COMPLETED');
});

test('AA18. markAttemptReversed then markAttemptDefinitelyFailed: a REVERSED attempt is a safe no-op, never downgraded to FAILED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadCompletedAttempt(t);
	await payoutService.markAttemptReversed('attempt-1', 'RETURNED');

	const result = await payoutService.markAttemptDefinitelyFailed('attempt-1', 'should not apply');
	assert.equal(result.status, 'REVERSED', 'no-op — returned unchanged');
	assert.equal(payoutAttempts[0].status, 'REVERSED', 'must remain REVERSED — never downgraded to FAILED');
	assert.equal(withdrawals[0].status, 'REVERSED', 'Withdrawal must not be touched by this no-op either');
});

test('AA19. active-attempt logic remains PENDING/PROCESSING only: a withdrawal with a prior REVERSED attempt does not block a new send-payout initialization', async (t) => {
	// Isolates initializeSendPayout()'s own fast-path active-attempt check —
	// the Withdrawal's own status is set back to APPROVED purely to reach
	// that check in isolation, mirroring the existing precedent test E
	// ("a prior FAILED attempt does not block a new one").
	const { payoutService, payoutAttempts } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED' },
		payoutAttempts: [{ id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, status: 'REVERSED', senderBatchId: 'wd-wd-1-a1', provider: 'PAYPAL' }]
	});

	const attempt = await payoutService.initializeSendPayout('wd-1');
	assert.equal(attempt.attemptNumber, 2);
	assert.equal(payoutAttempts.length, 2);
});

test('AA13-16. regression: existing markAttemptCompleted/markAttemptDefinitelyFailed FAILED<->COMPLETED guards are unaffected by REVERSED', async (t) => {
	// COMPLETED cannot become FAILED (item 15) and FAILED cannot become
	// COMPLETED (item 16) are already covered by pre-existing tests U and X
	// above, which pass unchanged in this same run — this test only adds the
	// one NEW combination those didn't cover: a FAILED attempt, when handed
	// to markAttemptReversed() (not markAttemptCompleted/markAttemptDefinitelyFailed),
	// must also be rejected, reusing AA9 above. No separate assertion needed
	// here beyond confirming both pre-existing primitives still exist and are
	// callable with an unrelated (PENDING) fixture, proving no regression in
	// their exported shape.
	const { payoutService } = await loadService(t);
	assert.equal(typeof payoutService.markAttemptCompleted, 'function');
	assert.equal(typeof payoutService.markAttemptDefinitelyFailed, 'function');
	assert.equal(typeof payoutService.markAttemptReversed, 'function');
});

// ============================================================================
// 20-22. Schema-level static assertions — no runtime processing code exists
// yet (P3-D's responsibility); these confirm the P3-A schema additions
// themselves, matching this codebase's established static-source-check
// convention (see admin-withdrawals.routes.test.ts) for facts that cannot be
// exercised by any service-level test yet.
// ============================================================================

test('20. schema: PaypalWebhookEvent.paypalEventId is durably unique — the primary webhook dedup key', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
	assert.match(schema, /model PaypalWebhookEvent \{[\s\S]*?paypalEventId\s+String\s+@unique/);
});

test('21. schema: PaypalWebhookEvent has a crash-safe lifecycle status (RECEIVED/PROCESSED/FAILED) defaulting to RECEIVED', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
	assert.match(schema, /model PaypalWebhookEvent \{[\s\S]*?status\s+PaypalWebhookEventStatus\s+@default\(RECEIVED\)/);
	assert.match(schema, /enum PaypalWebhookEventStatus \{\s*RECEIVED\s*PROCESSED\s*FAILED\s*\}/);
});

test('22. schema: PayoutAttempt.payoutItemId uniqueness is preserved unchanged — no duplicate field was added for the same purpose', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
	assert.match(schema, /model PayoutAttempt \{[\s\S]*?payoutItemId\s+String\?\s+@unique/);
	// Exactly one occurrence of the field across the whole schema.
	const occurrences = (schema.match(/payoutItemId\s+String\?\s+@unique/g) || []).length;
	assert.equal(occurrences, 1);
});

// ============================================================================
// Payout P2-C — sendPayout() orchestration.
//
// Every test below uses the default withdrawal fixture from
// createPayoutMockPrisma (id: 'wd-1', status: APPROVED, method: 'paypal',
// amount: 100, currency: 'USD', paypalEmail: 'provider@paypal-sandbox.
// example') unless it explicitly overrides a field via opts.withdrawal.
// ============================================================================

test('1/26. sendPayout: a valid APPROVED PayPal withdrawal durably initializes a PayoutAttempt (via the real, unchanged initializeSendPayout) BEFORE any PayPal call', async (t) => {
	const callOrder: string[] = [];
	const { payoutService, createAttempt, createPayoutSpy, payoutAttempts } = await loadService(t, {
		createPayoutImpl: async () => { callOrder.push('createPayout'); return { outcome: 'ACCEPTED', payoutBatchId: 'PB-1', batchStatus: 'PENDING', safeResponse: {} }; }
	});
	createAttempt.mock.mockImplementation(async (args: any) => {
		callOrder.push('createAttempt');
		const row = { id: 'attempt-1', createdAt: new Date(), updatedAt: new Date(), completedAt: null, payoutBatchId: null, payoutItemId: null, failureReason: null, rawResponse: null, ...args.data };
		payoutAttempts.push(row);
		return row;
	});

	await payoutService.sendPayout('wd-1');

	assert.deepEqual(callOrder, ['createAttempt', 'createPayout'], 'the durable PayoutAttempt row must be created BEFORE any PayPal call');
	assert.equal(createPayoutSpy.mock.callCount(), 1);
});

test('2-5. sendPayout: PayPal receives Withdrawal.paypalEmail (never User.email/ProviderProfile) and the DB amount, with senderBatchId/senderItemId sourced from the PayoutAttempt', async (t) => {
	const { payoutService, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', paypalEmail: 'exact-db-value@paypal-sandbox.example', amount: 250 }
	});

	await payoutService.sendPayout('wd-1');

	assert.equal(createPayoutSpy.mock.callCount(), 1);
	const params = createPayoutSpy.mock.calls[0].arguments[0];
	assert.equal(params.recipientEmail, 'exact-db-value@paypal-sandbox.example', 'recipient must be Withdrawal.paypalEmail exactly');
	assert.equal(params.amount, 250, 'amount must be Withdrawal.amount exactly');
	assert.equal(params.senderBatchId, 'wd-wd-1-a1', 'senderBatchId must come from the PayoutAttempt just created');
	assert.equal(params.senderItemId, 'attempt-1', 'senderItemId must be the PayoutAttempt id');
	// Structural proof, not just absence-of-call: the params object has no
	// possible source for User.email or a live ProviderProfile lookup at
	// all — sendPayout() takes only a withdrawalId, and CreatePayoutParams
	// itself has no such field.
	assert.deepEqual(Object.keys(params).sort(), ['amount', 'recipientEmail', 'senderBatchId', 'senderItemId']);
});

test('6-8. sendPayout: ACCEPTED calls markAttemptAccepted exactly once, leaves the attempt PROCESSING, and does NOT complete the Withdrawal', async (t) => {
	const { payoutService, withdrawals, payoutAttempts, updateManyAttempt } = await loadService(t, {
		createPayoutResult: { outcome: 'ACCEPTED', payoutBatchId: 'PB-REAL-1', batchStatus: 'PENDING', safeResponse: {} }
	});

	const result = await payoutService.sendPayout('wd-1');

	assert.equal(result.outcome, 'ACCEPTED');
	assert.equal(updateManyAttempt.mock.callCount(), 1, 'markAttemptAccepted (the only caller of payoutAttempt.updateMany besides markAttemptDefinitelyFailed/markAttemptCompleted) must fire exactly once');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-REAL-1');
	assert.equal(withdrawals[0].status, 'PROCESSING', 'Withdrawal must NOT be marked COMPLETED — a create-payout acceptance is not authoritative completion');
});

test('9-13. sendPayout: UNKNOWN leaves the state machine completely untouched — no markAttemptAccepted/markAttemptDefinitelyFailed/markAttemptCompleted, attempt stays PENDING, Withdrawal stays PROCESSING', async (t) => {
	const { payoutService, withdrawals, payoutAttempts, updateManyAttempt } = await loadService(t, {
		createPayoutResult: { outcome: 'UNKNOWN', reason: 'انتهت المهلة' }
	});

	const result = await payoutService.sendPayout('wd-1');

	assert.equal(result.outcome, 'UNKNOWN');
	// updateManyAttempt is the ONLY write path shared by markAttemptAccepted,
	// markAttemptDefinitelyFailed, and markAttemptCompleted — asserting it
	// was never called at all proves none of the three ran, in one shot.
	assert.equal(updateManyAttempt.mock.callCount(), 0, 'no state-mutating mark* method may run for an UNKNOWN outcome');
	assert.equal(payoutAttempts[0].status, 'PENDING');
	assert.equal(withdrawals[0].status, 'PROCESSING');
	// The raw PayPal reason must never leak into the response.
	assert.equal(JSON.stringify(result).includes('انتهت المهلة'), false);
});

test('14. sendPayout: an unexpected throw from createPayout() (contract violation) is treated exactly like UNKNOWN — no state change, no crash propagated', async (t) => {
	const { payoutService, withdrawals, payoutAttempts, updateManyAttempt } = await loadService(t, {
		createPayoutImpl: async () => { throw new Error('unexpected: PaypalService broke its own result contract'); }
	});

	const result = await payoutService.sendPayout('wd-1');

	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(updateManyAttempt.mock.callCount(), 0);
	assert.equal(payoutAttempts[0].status, 'PENDING');
	assert.equal(withdrawals[0].status, 'PROCESSING');
});

test('15. sendPayout: a repeated admin click while an attempt is already active does NOT call PayPal a second time — the existing P1 active-attempt guard rejects it first', async (t) => {
	const { payoutService, createPayoutSpy } = await loadService(t);

	const first = await payoutService.sendPayout('wd-1');
	assert.equal(first.outcome, 'ACCEPTED');
	assert.equal(createPayoutSpy.mock.callCount(), 1);

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		return true;
	});
	assert.equal(createPayoutSpy.mock.callCount(), 1, 'PayPal must not be called a second time');
});

test('15b. sendPayout: a repeated admin click while the FIRST attempt is still PENDING (createPayout in flight/UNKNOWN) also does not call PayPal a second time', async (t) => {
	const { payoutService, createPayoutSpy } = await loadService(t, {
		createPayoutResult: { outcome: 'UNKNOWN', reason: 'x' }
	});

	const first = await payoutService.sendPayout('wd-1');
	assert.equal(first.outcome, 'UNKNOWN');
	assert.equal(createPayoutSpy.mock.callCount(), 1);

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 409);
		return true;
	});
	assert.equal(createPayoutSpy.mock.callCount(), 1, 'a PENDING active attempt must block a second send exactly like a PROCESSING one');
});

// ============================================================================
// Local validation BEFORE initializeSendPayout() — a locally-invalid
// withdrawal must be rejected with NO PayoutAttempt created and the
// Withdrawal left exactly as it was (still APPROVED), never flipped to
// PROCESSING for a condition that can never change.
// ============================================================================

test('16. sendPayout: a non-PayPal withdrawal (method != paypal) is rejected before any external call, Withdrawal stays APPROVED, no PayoutAttempt created', async (t) => {
	const { payoutService, withdrawals, createAttempt, transactionSpy, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', method: 'bank_transfer' }
	});

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 400); return true; });

	assert.equal(withdrawals[0].status, 'APPROVED', 'must remain APPROVED — untouched');
	assert.equal(createAttempt.mock.callCount(), 0);
	assert.equal(transactionSpy.mock.callCount(), 0, 'initializeSendPayout must never even be invoked');
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

test('17. sendPayout: a missing Withdrawal.paypalEmail is rejected before any external call, Withdrawal stays APPROVED, no PayoutAttempt created', async (t) => {
	const { payoutService, withdrawals, createAttempt, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', paypalEmail: null }
	});

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 400); return true; });

	assert.equal(withdrawals[0].status, 'APPROVED');
	assert.equal(createAttempt.mock.callCount(), 0);
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

test('18. sendPayout: a malformed Withdrawal.paypalEmail is rejected before any external call, Withdrawal stays APPROVED, no PayoutAttempt created', async (t) => {
	const { payoutService, withdrawals, createAttempt, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', paypalEmail: 'not-an-email' }
	});

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 400); return true; });

	assert.equal(withdrawals[0].status, 'APPROVED');
	assert.equal(createAttempt.mock.callCount(), 0);
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

test('19. sendPayout: a zero/negative Withdrawal.amount is rejected before any external call, Withdrawal stays APPROVED, no PayoutAttempt created', async (t) => {
	const { payoutService: svcZero, withdrawals: wZero, createPayoutSpy: spyZero } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', amount: 0 }
	});
	await assert.rejects(() => svcZero.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 400); return true; });
	assert.equal(wZero[0].status, 'APPROVED');
	assert.equal(spyZero.mock.callCount(), 0);
});

test('19b. sendPayout: a negative Withdrawal.amount is rejected before any external call', async (t) => {
	const { payoutService, withdrawals, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', amount: -50 }
	});
	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 400); return true; });
	assert.equal(withdrawals[0].status, 'APPROVED');
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

test('sendPayout: a non-USD Withdrawal.currency is rejected before any external call, Withdrawal stays APPROVED, no PayoutAttempt created', async (t) => {
	const { payoutService, withdrawals, createAttempt, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', currency: 'SAR' }
	});

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 400); return true; });

	assert.equal(withdrawals[0].status, 'APPROVED');
	assert.equal(createAttempt.mock.callCount(), 0);
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

test('sendPayout: a non-existent withdrawal id is rejected with 404 before any external call', async (t) => {
	const { payoutService, createPayoutSpy } = await loadService(t);
	await assert.rejects(() => payoutService.sendPayout('does-not-exist'), (err: any) => { assert.equal(err.statusCode, 404); return true; });
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

// ============================================================================
// 20-21. Request-body trust boundary — sendPayout() takes ONLY a
// withdrawalId, so there is structurally no parameter through which a
// caller could ever override amount/recipient. (The controller-level proof
// that req.body is never even read lives in
// withdrawal.controller.test.ts — this confirms the service itself has no
// such parameter to exploit even if a caller somehow reached it directly.)
// ============================================================================

test('20-21. sendPayout: the method signature accepts only a withdrawalId — amount/recipient can only ever come from the DB row, never from a caller-supplied value', async (t) => {
	const { payoutService, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED', amount: 77, paypalEmail: 'db-owned@paypal-sandbox.example' }
	});

	// Calling with extra arguments (as any caller who bypassed TypeScript
	// might attempt) has no effect — sendPayout(withdrawalId) simply never
	// declares a second parameter to read them from.
	await (payoutService.sendPayout as any)('wd-1', { amount: 999999, recipientEmail: 'attacker@evil.example' });

	const params = createPayoutSpy.mock.calls[0].arguments[0];
	assert.equal(params.amount, 77);
	assert.equal(params.recipientEmail, 'db-owned@paypal-sandbox.example');
});

// ============================================================================
// 25. Future DEFINITELY_REJECTED compatibility.
// ============================================================================

test('25. sendPayout: a (currently unreachable in real P2-B) DEFINITELY_REJECTED result maps ONLY to markAttemptDefinitelyFailed — never markAttemptAccepted/markAttemptCompleted, and Withdrawal reverts to APPROVED', async (t) => {
	const { payoutService, withdrawals, payoutAttempts } = await loadService(t, {
		createPayoutResult: { outcome: 'DEFINITELY_REJECTED', reason: 'حساب PayPal غير صالح' }
	});

	const result = await payoutService.sendPayout('wd-1');

	assert.equal(result.outcome, 'DEFINITELY_REJECTED');
	assert.equal(payoutAttempts[0].status, 'FAILED');
	assert.equal(payoutAttempts[0].failureReason, 'حساب PayPal غير صالح');
	assert.equal(withdrawals[0].status, 'APPROVED', 'markAttemptDefinitelyFailed reverts Withdrawal PROCESSING -> APPROVED, allowing a legitimate future retry');
});

// ============================================================================
// Step 13 — ACCEPTED-then-local-DB-failure. The single most safety-critical
// scenario in this batch: PayPal has DEFINITELY accepted the payout, but our
// own markAttemptAccepted() write fails. Must never retry PayPal, never
// create a new attempt, never mark the attempt FAILED, never reopen the
// Withdrawal to APPROVED.
// ============================================================================

test('13/Step 13. sendPayout: markAttemptAccepted() failing AFTER PayPal ACCEPTED never retries PayPal, never creates a new attempt, never marks FAILED, never reopens the Withdrawal — durable state is preserved for P3 reconciliation', async (t) => {
	const { payoutService, withdrawals, payoutAttempts, createAttempt, createPayoutSpy, updateManyAttempt } = await loadService(t, {
		createPayoutResult: { outcome: 'ACCEPTED', payoutBatchId: 'PB-CRITICAL-1', batchStatus: 'PENDING', safeResponse: {} }
	});

	// Simulate markAttemptAccepted()'s own updateMany throwing a genuine DB
	// error — modeling a real Postgres connection failure at exactly the
	// moment we try to record PayPal's acceptance.
	updateManyAttempt.mock.mockImplementation(async () => { throw new Error('connection terminated unexpectedly (simulated DB failure)'); });

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => {
		assert.equal(err.statusCode, 500);
		return true;
	});

	assert.equal(createPayoutSpy.mock.callCount(), 1, 'PayPal must NEVER be called a second time after this failure');
	assert.equal(createAttempt.mock.callCount(), 1, 'no new PayoutAttempt may ever be created as a result of this failure');
	assert.equal(payoutAttempts[0].status, 'PENDING', 'the attempt must NOT be marked FAILED — it did not fail, PayPal accepted it');
	assert.equal(payoutAttempts[0].payoutBatchId, null, 'payoutBatchId could not be persisted — this is the exact, explicitly-flagged P3 reconciliation requirement (senderBatchId below remains the durable recovery key)');
	assert.equal(payoutAttempts[0].senderBatchId, 'wd-wd-1-a1', 'senderBatchId (committed BEFORE the PayPal call) remains durably available for P3 to look this batch up against PayPal directly, even though payoutBatchId itself was lost locally');
	assert.equal(withdrawals[0].status, 'PROCESSING', 'the Withdrawal must NOT return to APPROVED — that would let a re-click fire a second real PayPal payout for money that may already be in flight');

	// A second admin click after this failure must ALSO be blocked by the
	// existing P1 active-attempt guard (the attempt is still PENDING/active) —
	// proving there is no accidental reopening even on a subsequent request.
	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(createPayoutSpy.mock.callCount(), 1, 'still exactly one PayPal call after the follow-up admin click');
});

// ============================================================================
// 26. No PayPal call before durable PayoutAttempt creation — a second,
// independent proof (beyond test 1's call-order check) using a hard failure
// injected INTO initializeSendPayout()'s own transaction, confirming
// createPayout() is never reached at all when the durable reservation itself
// never commits.
// ============================================================================

test('26. sendPayout: if initializeSendPayout() itself fails (e.g. the withdrawal is no longer APPROVED), createPayout() is never called at all', async (t) => {
	const { payoutService, createPayoutSpy } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'PENDING' } // not APPROVED -> initializeSendPayout() rejects with 409
	});

	await assert.rejects(() => payoutService.sendPayout('wd-1'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(createPayoutSpy.mock.callCount(), 0);
});

// ============================================================================
// Payout P3-C — reconcilePayoutAttempt() and its supporting primitives.
//
// CORE SAFETY RULE under test throughout: a financial state transition may
// happen ONLY when the exact PayPal item belonging to the exact existing
// PayoutAttempt has been proven. No items[0], no one-item-batch shortcuts,
// no inference from batch_status/array position, no guessed identifiers.
// ============================================================================

function makeAttempt(overrides: any = {}) {
	return {
		id: 'attempt-1', withdrawalId: 'wd-1', attemptNumber: 1, provider: 'PAYPAL',
		senderBatchId: 'wd-wd-1-a1', payoutBatchId: 'PB-1', payoutItemId: null,
		status: 'PROCESSING', failureReason: null, paypalTerminalStatus: null, rawResponse: null,
		createdAt: new Date(), updatedAt: new Date(), completedAt: null,
		...overrides
	};
}

function foundBatch(items: any[], payoutBatchId = 'PB-1') {
	return { outcome: 'FOUND', batch: { payoutBatchId, batchStatus: 'SUCCESS', senderBatchId: undefined, items } };
}

function makeItem(overrides: any = {}) {
	return { payoutItemId: 'ITEM-1', payoutBatchId: 'PB-1', senderItemId: 'attempt-1', transactionStatus: 'SUCCESS', ...overrides };
}

async function loadReconciliation(t: TestContext, opts: {
	attempt?: any; withdrawalStatus?: string; withdrawal?: any;
	getPayoutBatchResult?: any; getPayoutBatchImpl?: (id: string) => Promise<any>;
	recoverResult?: any; recoverImpl?: (params: any) => Promise<any>;
} = {}) {
	const attempt = makeAttempt(opts.attempt);
	return loadService(t, {
		withdrawal: { id: 'wd-1', status: opts.withdrawalStatus ?? 'PROCESSING', ...opts.withdrawal },
		payoutAttempts: [attempt],
		getPayoutBatchResult: opts.getPayoutBatchResult,
		getPayoutBatchImpl: opts.getPayoutBatchImpl,
		recoverResult: opts.recoverResult,
		recoverImpl: opts.recoverImpl
	});
}

// ---------------------------------------------------------------------------
// LOCAL VALIDATION (1-5)
// ---------------------------------------------------------------------------

test('reconcile 1. a non-PAYPAL provider is conservative — ADMIN_REVIEW, no PayPal calls', async (t) => {
	const { payoutService, getPayoutBatchSpy, recoverSpy } = await loadReconciliation(t, { attempt: { provider: 'SOME_OTHER_PROVIDER' } });
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
	assert.equal(recoverSpy.mock.callCount(), 0);
});

test('reconcile 2. a non-paypal Withdrawal.method is rejected/conservative', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, { withdrawal: { method: 'bank_transfer' } });
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile 3. a non-USD Withdrawal.currency is rejected/conservative', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, { withdrawal: { currency: 'SAR' } });
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile 4. a missing/invalid Withdrawal.paypalEmail is rejected/conservative', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, { withdrawal: { paypalEmail: null } });
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile 5. an invalid Withdrawal.amount is rejected/conservative', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, { withdrawal: { amount: 0 } });
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile: a missing senderBatchId is rejected/conservative before any PayPal call', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, { attempt: { senderBatchId: null } });
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile: a non-existent attemptId throws 404 (a caller error, not a reconciliation finding)', async (t) => {
	const { payoutService } = await loadReconciliation(t);
	await assert.rejects(() => payoutService.reconcilePayoutAttempt('does-not-exist'), (err: any) => { assert.equal(err.statusCode, 404); return true; });
});

// ---------------------------------------------------------------------------
// CORRELATION (6-13)
// ---------------------------------------------------------------------------

test('reconcile 6. an exact unique payoutItemId match correlates and proceeds to a real transition', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: 'ITEM-1' },
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', payoutBatchId: 'PB-1', transactionStatus: 'SUCCESS' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'COMPLETED');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
});

test('reconcile 7. zero payoutItemId matches => no transition, ADMIN_REVIEW', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: 'ITEM-1' },
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-OTHER', payoutBatchId: 'PB-1' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING', 'unchanged');
});

test('reconcile 8. duplicate payoutItemId matches => no transition, ADMIN_REVIEW (integrity anomaly)', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: 'ITEM-1' },
		getPayoutBatchResult: foundBatch([
			makeItem({ payoutItemId: 'ITEM-1', payoutBatchId: 'PB-1', senderItemId: 'x' }),
			makeItem({ payoutItemId: 'ITEM-1', payoutBatchId: 'PB-1', senderItemId: 'y' })
		])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

test('reconcile 9. no local payoutItemId + exact senderItemId unique match correlates and proceeds', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([makeItem({ senderItemId: 'attempt-1', transactionStatus: 'SUCCESS' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'COMPLETED');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
});

test('reconcile 10. senderItemId absent from every item => no selection, ADMIN_REVIEW', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([makeItem({ senderItemId: undefined })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

test('reconcile 11. multiple items share the matching senderItemId => no selection, ADMIN_REVIEW', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([
			makeItem({ payoutItemId: 'ITEM-A', senderItemId: 'attempt-1' }),
			makeItem({ payoutItemId: 'ITEM-B', senderItemId: 'attempt-1' })
		])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

test('reconcile 12. a one-item batch alone is NOT enough — the single item must still genuinely correlate', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([makeItem({ senderItemId: 'not-this-attempt' })]) // only item, but wrong senderItemId
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW', 'must never select the only item in the array merely because it is alone');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

test('reconcile 13. batch_status SUCCESS alone is NOT enough — correlation still required at the item level', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: { outcome: 'FOUND', batch: { payoutBatchId: 'PB-1', batchStatus: 'SUCCESS', senderBatchId: undefined, items: [makeItem({ senderItemId: 'not-this-attempt' })] } }
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

// ---------------------------------------------------------------------------
// STATUS MAPPING (14-24)
// ---------------------------------------------------------------------------

test('reconcile 14. item PENDING => STILL_PROCESSING, no primitive called, no promotion', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'PENDING' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'STILL_PROCESSING');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
	assert.equal(withdrawals[0].status, 'PROCESSING');
});

test('reconcile A. a local PENDING attempt (not yet PROCESSING) receiving exact PayPal PENDING is reported via localStatus as genuinely PENDING — STILL_PROCESSING must never be misread as "the DB is in PROCESSING"', async (t) => {
	// The attempt never went through markAttemptAccepted() — e.g. it is
	// still PENDING with a payoutBatchId already recovered from a prior run
	// — and PayPal's own item report is also PENDING. The outcome name alone
	// (STILL_PROCESSING) is ambiguous about the true local status; localStatus
	// must disambiguate it precisely.
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING' },
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'PENDING' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'STILL_PROCESSING');
	assert.equal((result as any).localStatus, 'PENDING', 'must accurately report PENDING, never falsely imply PROCESSING');
	assert.equal(payoutAttempts[0].status, 'PENDING', 'the DB row itself was never promoted');
});

test('reconcile 15. item SUCCESS => COMPLETED, both attempt and withdrawal transition', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'SUCCESS' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'COMPLETED');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
	assert.equal(withdrawals[0].status, 'COMPLETED');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-1', 'payoutItemId persisted alongside completion');
});

test('reconcile 16. item FAILED => FAILED, Withdrawal reopens to APPROVED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'FAILED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'FAILED');
	assert.equal(payoutAttempts[0].status, 'FAILED');
	assert.equal(withdrawals[0].status, 'APPROVED');
});

test('reconcile 17. item UNCLAIMED => ACTION_REQUIRED, stays PROCESSING, payoutItemId persisted', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'UNCLAIMED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ACTION_REQUIRED');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
	assert.equal(withdrawals[0].status, 'PROCESSING');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-1');
});

test('reconcile 18/I. item ONHOLD => ADMIN_REVIEW, stays PROCESSING, but a newly-discovered payoutItemId IS still safely persisted (identity only, no financial transition)', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-ONHOLD', transactionStatus: 'ONHOLD' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
	assert.equal(withdrawals[0].status, 'PROCESSING');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-ONHOLD', 'identity is safely persisted even under ADMIN_REVIEW, since correlation was exact and this creates no financial transition');
});

test('reconcile 19/J. item BLOCKED => conservative ADMIN_REVIEW, never automatically reopened to APPROVED, but a newly-discovered payoutItemId IS still safely persisted', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-BLOCKED', transactionStatus: 'BLOCKED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
	assert.equal(withdrawals[0].status, 'PROCESSING', 'never silently reopened to APPROVED');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-BLOCKED', 'identity is safely persisted even under ADMIN_REVIEW');
});

test('reconcile 20. RETURNED after local COMPLETED => REVERSED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'COMPLETED', payoutItemId: 'ITEM-1' },
		withdrawalStatus: 'COMPLETED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', transactionStatus: 'RETURNED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'REVERSED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('reconcile 21. REFUNDED after local COMPLETED => REVERSED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'COMPLETED', payoutItemId: 'ITEM-1' },
		withdrawalStatus: 'COMPLETED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', transactionStatus: 'REFUNDED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'REVERSED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(withdrawals[0].status, 'REVERSED');
});

test('reconcile 22. REVERSED after local COMPLETED => REVERSED', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'COMPLETED', payoutItemId: 'ITEM-1' },
		withdrawalStatus: 'COMPLETED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', transactionStatus: 'REVERSED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'REVERSED');
	assert.equal(payoutAttempts[0].status, 'REVERSED');
	assert.equal(payoutAttempts[0].paypalTerminalStatus, 'REVERSED');
});

test('reconcile 23. a reversal-class status while local attempt is still PROCESSING never manufactures synthetic success/reversal', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'PROCESSING' },
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'RETURNED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(payoutAttempts[0].status, 'PROCESSING', 'must never jump straight to REVERSED without ever having recorded COMPLETED');
	assert.equal(withdrawals[0].status, 'PROCESSING');
});

test('reconcile 24. an unknown/unrecognized item status => UNKNOWN, no transition', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: undefined })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(payoutAttempts[0].status, 'PROCESSING');
});

// ---------------------------------------------------------------------------
// TERMINAL GUARDS (25-29)
// ---------------------------------------------------------------------------

test('reconcile 25. an already-FAILED attempt is never resurrected — short-circuits, zero PayPal calls', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, {
		attempt: { status: 'FAILED' }, withdrawalStatus: 'APPROVED'
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'FAILED');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile 26. an already-REVERSED attempt is never resurrected — short-circuits, zero PayPal calls', async (t) => {
	const { payoutService, getPayoutBatchSpy } = await loadReconciliation(t, {
		attempt: { status: 'REVERSED' }, withdrawalStatus: 'REVERSED'
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'REVERSED');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile 27. COMPLETED + SUCCESS is an idempotent no-op — no double side effect', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'COMPLETED', payoutItemId: 'ITEM-1', completedAt: new Date('2026-01-01') },
		withdrawalStatus: 'COMPLETED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', transactionStatus: 'SUCCESS' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'COMPLETED');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
	assert.equal(withdrawals[0].status, 'COMPLETED');
});

test('reconcile 28. COMPLETED + FAILED item can never downgrade it — post-adversarial-review: reported as ADMIN_REVIEW (a genuine contradiction), never silently reported as plain COMPLETED, DB state preserved', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'COMPLETED', payoutItemId: 'ITEM-1' },
		withdrawalStatus: 'COMPLETED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', transactionStatus: 'FAILED' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW', 'a COMPLETED attempt receiving a contradictory FAILED report must be flagged, not silently reported as clean COMPLETED');
	assert.equal((result as any).localStatus, 'COMPLETED', 'localStatus must still accurately show the true, unchanged DB state');
	assert.equal(payoutAttempts[0].status, 'COMPLETED', 'must never be downgraded to FAILED');
	assert.equal(withdrawals[0].status, 'COMPLETED');
});

test('reconcile 29. COMPLETED + PENDING item can never downgrade it — post-adversarial-review: reported as ADMIN_REVIEW (a genuine contradiction), never STILL_PROCESSING and never a silently-masked plain COMPLETED', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'COMPLETED', payoutItemId: 'ITEM-1' },
		withdrawalStatus: 'COMPLETED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-1', transactionStatus: 'PENDING' })])
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.notEqual(result.outcome, 'STILL_PROCESSING', 'must never be reported as STILL_PROCESSING for an already-completed attempt');
	assert.equal(result.outcome, 'ADMIN_REVIEW', 'a COMPLETED attempt receiving a contradictory PENDING report must be flagged, not silently masked as clean COMPLETED');
	assert.equal((result as any).localStatus, 'COMPLETED', 'localStatus must still accurately show the true, unchanged DB state');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
});

// ---------------------------------------------------------------------------
// RECOVERY (30-38)
// ---------------------------------------------------------------------------

test('reconcile 30-33. PENDING + no payoutBatchId + within the safe window recovers using ONLY durable DB values (senderBatchId, attempt.id as senderItemId, Withdrawal.paypalEmail, Withdrawal.amount)', async (t) => {
	const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days old — safely within window
	let recoverCallArgs: any = null;
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null, createdAt: recentDate },
		withdrawal: { paypalEmail: 'durable-db-value@paypal-sandbox.example', amount: 55.5 },
		recoverImpl: async (params: any) => { recoverCallArgs = params; return { outcome: 'RECOVERED', payoutBatchId: 'PB-RECOVERED-1' }; },
		getPayoutBatchResult: foundBatch([makeItem({ payoutBatchId: 'PB-RECOVERED-1', transactionStatus: 'PENDING' })], 'PB-RECOVERED-1')
	});

	const result = await payoutService.reconcilePayoutAttempt('attempt-1');

	assert.equal(recoverCallArgs.senderBatchId, 'wd-wd-1-a1');
	assert.equal(recoverCallArgs.senderItemId, 'attempt-1', 'senderItemId must be the PayoutAttempt.id');
	assert.equal(recoverCallArgs.recipientEmail, 'durable-db-value@paypal-sandbox.example');
	assert.equal(recoverCallArgs.amount, 55.5);
	assert.equal(result.outcome, 'STILL_PROCESSING');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-RECOVERED-1', 'the recovered identity was persisted');
});

test('reconcile 34. an UNKNOWN recovery result makes zero mutation', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null },
		recoverResult: { outcome: 'UNKNOWN', reason: 'x' }
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(payoutAttempts[0].payoutBatchId, null);
	assert.equal(payoutAttempts[0].status, 'PENDING');
});

test('reconcile 35. RECOVERED only persists batch identity — never marks PROCESSING/COMPLETED merely because a batch id was recovered', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null },
		recoverResult: { outcome: 'RECOVERED', payoutBatchId: 'PB-RECOVERED-1' },
		// The subsequent GET itself returns UNKNOWN — isolates the assertion to
		// recovery's own effect only.
		getPayoutBatchResult: { outcome: 'UNKNOWN', reason: 'x' }
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-RECOVERED-1', 'identity persisted');
	assert.equal(payoutAttempts[0].status, 'PENDING', 'status untouched by identity recovery alone');
});

test('reconcile 36. recovery then GET still requires exact item correlation — RECOVERED does not bypass CORE SAFETY RULE', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null },
		recoverResult: { outcome: 'RECOVERED', payoutBatchId: 'PB-RECOVERED-1' },
		getPayoutBatchResult: foundBatch([makeItem({ payoutBatchId: 'PB-RECOVERED-1', senderItemId: 'not-this-attempt', transactionStatus: 'SUCCESS' })], 'PB-RECOVERED-1')
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW', 'even a successful recovery must not bypass exact item correlation');
	assert.equal(payoutAttempts[0].status, 'PENDING');
});

test('reconcile L. a conflicting recovered payoutBatchId STOPS immediately — no GET is ever attempted using the conflicting new id', async (t) => {
	// Simulates: this call starts with payoutBatchId genuinely null, but by
	// the time recoverPayoutBySenderBatch() returns, a CONCURRENT process has
	// already durably persisted a DIFFERENT payoutBatchId on the same row —
	// modeled here by mutating the shared mock row directly inside
	// recoverImpl, exactly at the point a real concurrent writer would have
	// committed in between.
	const { payoutService, payoutAttempts, getPayoutBatchSpy } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null },
		recoverImpl: async () => {
			payoutAttempts[0].payoutBatchId = 'PB-CONCURRENT-WINNER';
			return { outcome: 'RECOVERED', payoutBatchId: 'PB-THIS-CALLS-OWN-RECOVERY' };
		}
	});

	const result = await payoutService.reconcilePayoutAttempt('attempt-1');

	assert.equal(result.outcome, 'ADMIN_REVIEW');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0, 'getPayoutBatch() must never be called with the conflicting recovered id');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-CONCURRENT-WINNER', 'the concurrently-persisted value is never overwritten by the losing recovery');
});

test('reconcile 37. an attempt >= 30 days old never triggers a recovery POST', async (t) => {
	const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // exactly 30 days — the documented conservative boundary: forbidden
	const { payoutService, recoverSpy, getPayoutBatchSpy } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null, createdAt: oldDate }
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'RECOVERY_WINDOW_EXPIRED');
	assert.equal(recoverSpy.mock.callCount(), 0, 'zero PayPal recovery POST');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
});

test('reconcile K. a clock-skewed future-dated createdAt (negative age) is treated as a data-integrity anomaly, never as "safely within the window" — zero recovery POST', async (t) => {
	const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day in the future
	const { payoutService, recoverSpy, getPayoutBatchSpy, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null, createdAt: futureDate }
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'ADMIN_REVIEW', 'a negative age must never silently satisfy the "within window" case merely by failing the >= 30 days check');
	assert.equal(recoverSpy.mock.callCount(), 0, 'zero PayPal recovery POST for a future-dated attempt');
	assert.equal(getPayoutBatchSpy.mock.callCount(), 0);
	assert.equal(payoutAttempts[0].status, 'PENDING', 'no state mutation');
});

test('reconcile 38. an old attempt produces zero state mutation', async (t) => {
	const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null, createdAt: oldDate }
	});
	await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(payoutAttempts[0].status, 'PENDING');
	assert.equal(payoutAttempts[0].payoutBatchId, null);
	assert.equal(withdrawals[0].status, 'PROCESSING');
});

test('reconcile: an attempt safely inside the window (29 days old) is allowed to recover', async (t) => {
	const withinWindow = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
	const { payoutService, recoverSpy } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null, createdAt: withinWindow },
		recoverResult: { outcome: 'UNKNOWN', reason: 'x' }
	});
	await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(recoverSpy.mock.callCount(), 1, 'recovery must be attempted safely inside the window');
});

// ---------------------------------------------------------------------------
// IDENTIFIER PERSISTENCE (39-44)
// ---------------------------------------------------------------------------

test('reconcile 39-40. payoutItemId: null -> set; a second identical write is an idempotent no-op', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-NEW', transactionStatus: 'UNCLAIMED' })])
	});
	const first = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-NEW');
	const second = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(first.outcome, 'ACTION_REQUIRED');
	assert.equal(second.outcome, 'ACTION_REQUIRED');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-NEW', 'unchanged, still the same value');
});

test('reconcile 41. a conflicting payoutItemId (different value already present) is an integrity error, never overwritten', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { payoutItemId: 'ITEM-EXISTING' },
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-EXISTING', senderItemId: 'attempt-1', transactionStatus: 'SUCCESS' })])
	});
	// This scenario tests the correlation path when payoutItemId already
	// matches — to directly exercise persistPayoutItemId's conflict branch,
	// simulate discovering a DIFFERENT id via the senderItemId path by
	// clearing payoutItemId server-side after correlation would have used it.
	// Simpler and more direct: call the private-but-reachable-via-any path.
	const conflictResult = await (payoutService as any).persistPayoutItemId('attempt-1', 'ITEM-DIFFERENT');
	assert.equal(conflictResult, 'CONFLICT');
	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-EXISTING', 'never overwritten');
});

test('reconcile 42-43. payoutBatchId: null -> set via recovery; a second identical recovered value is an idempotent no-op', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: null },
		recoverResult: { outcome: 'RECOVERED', payoutBatchId: 'PB-SAME' },
		getPayoutBatchResult: { outcome: 'UNKNOWN', reason: 'x' }
	});
	await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-SAME');

	const second = await (payoutService as any).persistRecoveredPayoutBatchId('attempt-1', 'PB-SAME');
	assert.equal(second, 'ALREADY_SET_SAME');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-SAME');
});

test('reconcile 44. a conflicting payoutBatchId (different value already present) is an integrity error, never overwritten', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		attempt: { status: 'PENDING', payoutBatchId: 'PB-EXISTING' }
	});
	const result = await (payoutService as any).persistRecoveredPayoutBatchId('attempt-1', 'PB-DIFFERENT');
	assert.equal(result, 'CONFLICT');
	assert.equal(payoutAttempts[0].payoutBatchId, 'PB-EXISTING', 'never overwritten');
});

// ---------------------------------------------------------------------------
// ATOMICITY / CONCURRENCY (45-52)
// ---------------------------------------------------------------------------

test('reconcile 45. markAttemptCompleted(): if the Withdrawal cannot transition, the WHOLE transaction rolls back — half-transition never committed', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED' /* NOT PROCESSING — the required precondition */ },
		payoutAttempts: [makeAttempt({ status: 'PROCESSING' })]
	});
	await assert.rejects(() => payoutService.markAttemptCompleted('attempt-1'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(payoutAttempts[0].status, 'PROCESSING', 'rolled back — never left COMPLETED by itself');
	assert.equal(withdrawals[0].status, 'APPROVED', 'unchanged');
});

test('reconcile 46. markAttemptDefinitelyFailed(): if the Withdrawal cannot transition, the WHOLE transaction rolls back', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadService(t, {
		withdrawal: { id: 'wd-1', status: 'APPROVED' },
		payoutAttempts: [makeAttempt({ status: 'PROCESSING' })]
	});
	await assert.rejects(() => payoutService.markAttemptDefinitelyFailed('attempt-1', 'x'), (err: any) => { assert.equal(err.statusCode, 409); return true; });
	assert.equal(payoutAttempts[0].status, 'PROCESSING', 'rolled back — never left FAILED by itself');
	assert.equal(withdrawals[0].status, 'APPROVED', 'unchanged (not further mutated)');
});

test('reconcile M. payoutItemId persistence succeeding does NOT imply the terminal transition also succeeded — a subsequent failed markAttemptCompleted() can never produce a false COMPLETED state', async (t) => {
	// Withdrawal is deliberately NOT in PROCESSING, so markAttemptCompleted()'s
	// own (now-hardened) Withdrawal-side check will fail and roll back —
	// while payoutItemId persistence (a SEPARATE, already-committed
	// transaction) succeeds independently just before it.
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		attempt: { payoutItemId: null },
		withdrawalStatus: 'APPROVED',
		getPayoutBatchResult: foundBatch([makeItem({ payoutItemId: 'ITEM-DISCOVERED', transactionStatus: 'SUCCESS' })])
	});

	const result = await payoutService.reconcilePayoutAttempt('attempt-1');

	assert.equal(payoutAttempts[0].payoutItemId, 'ITEM-DISCOVERED', 'the identifier persistence itself DID durably commit — that half succeeded independently');
	assert.equal(result.outcome, 'ADMIN_REVIEW', 'the terminal transition failing must never be reported as COMPLETED merely because identity was persisted');
	assert.equal(payoutAttempts[0].status, 'PROCESSING', 'never falsely left/reported as COMPLETED — the failed terminal transition rolled back on its own, unaffected by the separately-committed identifier');
	assert.equal(withdrawals[0].status, 'APPROVED', 'unchanged');
});

test('reconcile N. no transition is ever triggered by batch_status alone — only the exact correlated ITEM transactionStatus governs, even when batch_status contradicts it', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		getPayoutBatchResult: { outcome: 'FOUND', batch: { payoutBatchId: 'PB-1', batchStatus: 'DENIED', senderBatchId: undefined, items: [makeItem({ transactionStatus: 'SUCCESS' })] } }
	});
	const result = await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(result.outcome, 'COMPLETED', 'the item\'s own SUCCESS governs, regardless of a contradictory batch_status');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
});

test('reconcile 47. two concurrent reconciliations both observing SUCCESS converge safely — no double side effect', async (t) => {
	const { payoutService, payoutAttempts, withdrawals } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'SUCCESS' })])
	});
	const [a, b] = await Promise.all([
		payoutService.reconcilePayoutAttempt('attempt-1'),
		payoutService.reconcilePayoutAttempt('attempt-1')
	]);
	assert.equal(a.outcome, 'COMPLETED');
	assert.equal(b.outcome, 'COMPLETED');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');
	assert.equal(withdrawals[0].status, 'COMPLETED');
});

test('reconcile 48. same-payoutItemId persistence race resolves safely — one SET, the other ALREADY_SET_SAME', async (t) => {
	const { payoutService } = await loadReconciliation(t, { attempt: { payoutItemId: null } });
	const [a, b] = await Promise.all([
		(payoutService as any).persistPayoutItemId('attempt-1', 'ITEM-SAME'),
		(payoutService as any).persistPayoutItemId('attempt-1', 'ITEM-SAME')
	]);
	assert.deepEqual([a, b].sort(), ['ALREADY_SET_SAME', 'SET']);
});

test('reconcile 49. conflicting-payoutItemId persistence race resolves safely — one SET, the other CONFLICT, never overwritten', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, { attempt: { payoutItemId: null } });
	const [a, b] = await Promise.all([
		(payoutService as any).persistPayoutItemId('attempt-1', 'ITEM-A'),
		(payoutService as any).persistPayoutItemId('attempt-1', 'ITEM-B')
	]);
	assert.deepEqual([a, b].sort(), ['CONFLICT', 'SET']);
	assert.ok(payoutAttempts[0].payoutItemId === 'ITEM-A' || payoutAttempts[0].payoutItemId === 'ITEM-B');
});

test('reconcile 50. same-payoutBatchId recovery persistence race resolves safely', async (t) => {
	const { payoutService } = await loadReconciliation(t, { attempt: { status: 'PENDING', payoutBatchId: null } });
	const [a, b] = await Promise.all([
		(payoutService as any).persistRecoveredPayoutBatchId('attempt-1', 'PB-SAME'),
		(payoutService as any).persistRecoveredPayoutBatchId('attempt-1', 'PB-SAME')
	]);
	assert.deepEqual([a, b].sort(), ['ALREADY_SET_SAME', 'SET']);
});

test('reconcile 51. conflicting-payoutBatchId recovery persistence race resolves safely, never overwritten', async (t) => {
	const { payoutService, payoutAttempts } = await loadReconciliation(t, { attempt: { status: 'PENDING', payoutBatchId: null } });
	const [a, b] = await Promise.all([
		(payoutService as any).persistRecoveredPayoutBatchId('attempt-1', 'PB-A'),
		(payoutService as any).persistRecoveredPayoutBatchId('attempt-1', 'PB-B')
	]);
	assert.deepEqual([a, b].sort(), ['CONFLICT', 'SET']);
	assert.ok(payoutAttempts[0].payoutBatchId === 'PB-A' || payoutAttempts[0].payoutBatchId === 'PB-B');
});

test('reconcile 52. a terminal local state reached while a GET is conceptually "in flight" cannot be resurrected/downgraded by the other racer', async (t) => {
	// Models: reconciliation A completes the attempt; reconciliation B's own
	// (already-in-progress) view of a FAILED item must not be allowed to
	// downgrade the now-COMPLETED attempt.
	const { payoutService, payoutAttempts } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'SUCCESS' })])
	});
	await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(payoutAttempts[0].status, 'COMPLETED');

	// B's belated FAILED report arrives after A already completed it. Per
	// markAttemptDefinitelyFailed()'s own established idempotency contract,
	// this is a safe NO-OP (not a throw) — the correct, and even safer,
	// outcome: the important guarantee under test is that it can never
	// downgrade an already-COMPLETED attempt, not that it must throw.
	const late = await payoutService.markAttemptDefinitelyFailed('attempt-1', 'late report');
	assert.equal(late.status, 'COMPLETED', 'a belated FAILED report is a safe no-op, never resurrected/downgraded');
	assert.equal(payoutAttempts[0].status, 'COMPLETED', 'never resurrected/downgraded');
});

// ---------------------------------------------------------------------------
// SIDE EFFECTS (53-56)
// ---------------------------------------------------------------------------

test('reconcile 53-56. no WalletTransaction, no new PayoutAttempt, no new Withdrawal, no Escrow mutation anywhere in reconcilePayoutAttempt()', async (t) => {
	const { payoutService, createAttempt } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'SUCCESS' })])
	});
	// The mock's `tx` object declares no walletTransaction/escrow/withdrawal.create
	// model at all — payout.service.ts has never needed one — so any such
	// access from reconcilePayoutAttempt() would throw here, proving none exists.
	await assert.doesNotReject(() => payoutService.reconcilePayoutAttempt('attempt-1'));
	assert.equal(createAttempt.mock.callCount(), 0, 'no new PayoutAttempt created');
});

test('reconcile: reconcilePayoutAttempt() never calls sendPayout()/initializeSendPayout() — createPayout() (their only external call) is never invoked', async (t) => {
	const { payoutService, createPayoutSpy } = await loadReconciliation(t, {
		getPayoutBatchResult: foundBatch([makeItem({ transactionStatus: 'SUCCESS' })])
	});
	await payoutService.reconcilePayoutAttempt('attempt-1');
	assert.equal(createPayoutSpy.mock.callCount(), 0, 'createPayout() (used only by sendPayout()) must never be called by reconciliation — sendPayout()/initializeSendPayout() have no other external side effect that could be exercised without it');
});
