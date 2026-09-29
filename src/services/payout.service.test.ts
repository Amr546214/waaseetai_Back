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

function createPayoutMockPrisma(t: TestContext, opts: {
	withdrawal?: { id: string; status: string };
	payoutAttempts?: any[];
} = {}) {
	const withdrawals: any[] = [{ id: 'wd-1', status: 'APPROVED', ...opts.withdrawal }];
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
		const matches = payoutAttempts.filter(a => a.id === args.where.id && statusMatches(a.status, args.where.status));
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

	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });

	return {
		findUniqueWithdrawal, findFirstAttempt, countAttempt, createAttempt, updateManyWithdrawal, updateManyAttempt,
		findUniqueOrThrowAttempt, findUniqueAttempt, transactionSpy, withdrawals, payoutAttempts
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
