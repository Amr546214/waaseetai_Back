import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression guard for the USD-canonical transition: new withdrawal requests
// must explicitly carry currency USD (never rely on the Withdrawal schema's
// database default). Existing/historical Withdrawal rows are untouched
// by this — DEV currently has zero withdrawal rows to begin with.
//
// Financial Safety Batch 1, item 2: createForProvider() now runs its whole
// read-check-create sequence as one SERIALIZABLE prisma.$transaction (with a
// small retry loop for P2034 — Postgres's real conflict signal when two
// concurrent SERIALIZABLE transactions genuinely race). The mock below
// simulates this as `$transaction(fn, opts)` directly invoking `fn(tx)`
// against a SHARED, mutable withdrawal-rows array — which is exactly what
// the "loser" of a real Postgres race sees after being retried against the
// now-current state: a transaction that reads the TRUE, up-to-date pending
// total. A mock cannot reproduce Postgres's own conflict-detection/abort
// machinery, but it can (and does, below) prove the thing that machinery is
// there to protect: given a transaction that sees accurate current state,
// our code correctly computes and enforces the withdrawable-amount
// invariant, and never over-commits when a "concurrent" request has already
// reserved part of the balance.

// Matches a row's status against either a plain value (`status: 'PENDING'`)
// or a Prisma `{ in: [...] }` filter — both shapes are used across this
// file's real queries (createForProvider()'s outstanding-withdrawals
// aggregate now uses `in`; approve()'s/reject()'s conditional updateMany
// still uses a plain value).
function statusMatches(rowStatus: string, whereStatus: any): boolean {
	if (whereStatus === undefined) return true;
	if (whereStatus && typeof whereStatus === 'object' && 'in' in whereStatus) return whereStatus.in.includes(rowStatus);
	return rowStatus === whereStatus;
}

function createWithdrawalMockPrisma(t: TestContext, opts: {
	availableBalance?: number;
	seedWithdrawals?: { userId: string; amount: number; status: string }[];
	providerProfile?: { paypalPayoutEmail?: string | null } | null;
	// Finance #32: the stored bank data a bank withdrawal is resolved from (default: a stored IBAN; `null` = nothing stored).
	bankProfile?: { iban?: string | null; accountHolder?: string | null } | null;
	// Finance #33: when the provider's PayPal payout email was last changed (the 24 hour freeze is derived from it).
	paypalEmailChangedAt?: Date;
} = {}) {
	const withdrawals: any[] = (opts.seedWithdrawals || []).map((w, i) => ({ id: `seed-${i}`, ...w }));
	let nextId = withdrawals.length + 1;

	const aggregateSpy = t.mock.fn(async (args: any) => {
		const sum = withdrawals
			.filter(w => w.userId === args.where.userId && statusMatches(w.status, args.where.status))
			.reduce((s, w) => s + w.amount, 0);
		return { _sum: { amount: sum || null } };
	});
	const createSpy = t.mock.fn(async (args: any) => {
		const row = { id: `withdrawal-${nextId++}`, status: 'PENDING', ...args.data };
		withdrawals.push(row);
		return row;
	});

	// updateMany/findUniqueOrThrow — used by approve()'s and reject()'s own
	// conditional-transition transactions (both now wrap their PENDING ->
	// APPROVED/REJECTED write in prisma.$transaction), sharing the SAME
	// `withdrawals` array as everything else in this mock so a test can
	// exercise the real reject() alongside the real createForProvider().
	const updateManySpy = t.mock.fn(async (args: any) => {
		const matches = withdrawals.filter(w => w.id === args.where.id && w.status === args.where.status);
		matches.forEach(w => Object.assign(w, args.data));
		return { count: matches.length };
	});
	const findUniqueOrThrowSpy = t.mock.fn(async (args: any) => {
		const row = withdrawals.find(w => w.id === args.where.id);
		if (!row) throw new Error('not found (test mock)');
		return row;
	});
	// approve()'s WalletTransaction write — added so a test can exercise the
	// real createForProvider() -> approve() pipeline end-to-end and observe
	// exactly which referenceId the debit actually received.
	const walletTransactions: any[] = [];
	const walletTransactionCreateSpy = t.mock.fn(async (args: any) => {
		const wt = { id: `wt-${walletTransactions.length + 1}`, ...args.data };
		walletTransactions.push(wt);
		return wt;
	});

	const tx = {
		withdrawal: { aggregate: aggregateSpy, create: createSpy, updateMany: updateManySpy, findUniqueOrThrow: findUniqueOrThrowSpy },
		walletTransaction: { create: walletTransactionCreateSpy }
	};
	const transactionSpy = t.mock.fn(async (fn: any) => fn(tx));

	// Flat (non-transaction) access, sharing the SAME withdrawals array —
	// used by reject()/approve()/get()/list(), which this batch does not
	// change. Needed so a test can exercise the real reject() alongside the
	// real createForProvider() and observe their actual interaction.
	const findUniqueSpy = t.mock.fn(async (args: any) => withdrawals.find(w => w.id === args.where.id) ?? null);
	const updateSpy = t.mock.fn(async (args: any) => {
		const row = withdrawals.find(w => w.id === args.where.id);
		if (row) Object.assign(row, args.data);
		return row;
	});

	// Payout P2-A: createForProvider()'s PayPal-destination lookup — a flat
	// (non-transaction) read, resolved once per call before the retry loop.
	// `opts.providerProfile === undefined` (the default) means "no
	// ProviderProfile row at all" (findUnique resolves null), matching a
	// provider who never configured any PayPal destination.
	const providerProfileFindUniqueSpy = t.mock.fn(async (args: any) =>
		args?.select?.iban
			? (opts.bankProfile === undefined ? { iban: 'SA-STORED-0000000000000000', accountHolder: 'Stored Holder' } : opts.bankProfile)
			: (opts.providerProfile === undefined ? null : opts.providerProfile)
	);

	const prismaMock: any = {
		$transaction: transactionSpy,
		withdrawal: { findUnique: findUniqueSpy, update: updateSpy },
		providerProfile: { findUnique: providerProfileFindUniqueSpy },
		accountAuditLog: { findFirst: async (args: any) => (opts.paypalEmailChangedAt && opts.paypalEmailChangedAt > args.where.occurredAt.gt ? { occurredAt: opts.paypalEmailChangedAt } : null) },
		// Release-blocker fix: approve() resolves the ledger from the owner's
		// identity. Every fixture in this file is a plain provider (no
		// AffiliateProfile) -> provider-wallet ledger, i.e. unchanged behavior.
		user: { findUnique: t.mock.fn(async () => ({ accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null })) }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

	const getWalletSpy = t.mock.fn(async (_userId: string, _client?: unknown) => ({
		summary: { availableBalance: opts.availableBalance ?? 1000, currency: 'USD' }
	}));
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: getWalletSpy } }
	});

	return { createSpy, aggregateSpy, transactionSpy, getWalletSpy, withdrawals, walletTransactions, walletTransactionCreateSpy, providerProfileFindUniqueSpy };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createWithdrawalMockPrisma>[1]) {
	const mocks = createWithdrawalMockPrisma(t, opts);
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);
	return { withdrawalService, ...mocks };
}

test('createForProvider: a new withdrawal request is explicitly created with currency USD', async (t) => {
	const { withdrawalService, createSpy, transactionSpy } = await loadService(t, { availableBalance: 500 });

	await withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(createSpy.mock.callCount(), 1);
	assert.equal(createSpy.mock.calls[0].arguments[0].data.currency, 'USD');
	assert.equal(createSpy.mock.calls[0].arguments[0].data.amount, 200);
	// Ran inside the serializable transaction, not as a bare top-level create.
	assert.equal(transactionSpy.mock.callCount(), 1);
	assert.equal(transactionSpy.mock.calls[0].arguments[1]?.isolationLevel, 'Serializable');
});

test('createForProvider: rejects a request exceeding the available (escrow-derived) balance, and creates nothing', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 100 });

	await assert.rejects(() => withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' }));
	assert.equal(createSpy.mock.callCount(), 0);
});

test('createForProvider: the released-earnings read is taken from inside the transaction (via tx), not the global client', async (t) => {
	const { withdrawalService, getWalletSpy } = await loadService(t, { availableBalance: 500 });

	await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(getWalletSpy.mock.callCount(), 1);
	assert.equal(getWalletSpy.mock.calls[0].arguments[0], 'provider-1');
	// Second argument is the transaction client (`tx`), not undefined/global —
	// this is what makes the released-earnings figure part of the same
	// serializable snapshot as the pending-withdrawal read and the insert.
	assert.notEqual(getWalletSpy.mock.calls[0].arguments[1], undefined);
});

test('createForProvider: a sequential second withdrawal correctly respects the first — the combined total cannot exceed available earnings', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 500 });

	await withdrawalService.createForProvider('provider-1', { amount: 300, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	// 300 already pending; only 200 left. A second request for 300 must fail.
	await assert.rejects(() => withdrawalService.createForProvider('provider-1', { amount: 300, method: 'bank_transfer', iban: 'SA0000000000000000000000' }));
	// But a second request for exactly the remainder must succeed.
	const second = await withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(second.amount, 200);
});

test('createForProvider: two concurrent requests for the same provider cannot together exceed available earnings — the second sees the first\'s reservation and is rejected', async (t) => {
	// Two independently-loaded instances, each with its OWN isolated mock
	// state, run via Promise.all — exactly the "loser retried against
	// now-current state" shape a real SERIALIZABLE conflict-and-retry
	// produces. What's actually under test is the invariant itself (the
	// combined total can never exceed availableBalance across the two
	// calls' visible-to-each-other state), not Postgres's own conflict
	// detection, which no in-process mock can reproduce.
	//
	// t.mock.module() only permits mocking a given specifier once per
	// TestContext, so each instance needs its own sub-TestContext.
	let first: Awaited<ReturnType<typeof loadService>>;
	let second: Awaited<ReturnType<typeof loadService>>;

	// Seed the SAME shared array reference into both mocks so the second
	// "concurrent" call genuinely observes the first's already-created row —
	// the one thing a true serializable retry guarantees the loser will see.
	const sharedWithdrawals: any[] = [];

	await t.test('request A', async (t2) => {
		first = await loadService(t2, { availableBalance: 500, seedWithdrawals: sharedWithdrawals });
		const rowA = await first.withdrawalService.createForProvider('provider-1', { amount: 400, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
		sharedWithdrawals.push({ id: rowA.id, userId: 'provider-1', amount: rowA.amount, status: 'PENDING' });
	});

	let secondRejected = false;
	await t.test('request B (retried against A\'s already-committed reservation)', async (t2) => {
		second = await loadService(t2, { availableBalance: 500, seedWithdrawals: sharedWithdrawals });
		try {
			// 400 already reserved by A; only 100 left — 400 must fail.
			await second.withdrawalService.createForProvider('provider-1', { amount: 400, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
		} catch {
			secondRejected = true;
		}
	});

	assert.equal(secondRejected, true);
	assert.equal(first!.createSpy.mock.callCount(), 1);
	assert.equal(second!.createSpy.mock.callCount(), 0);
	// The combined total actually created never exceeds the 500 available.
	const totalCreated = first!.createSpy.mock.calls.reduce((s, c) => s + c.arguments[0].data.amount, 0)
		+ second!.createSpy.mock.calls.reduce((s, c) => s + c.arguments[0].data.amount, 0);
	assert.ok(totalCreated <= 500);
});

test('createForProvider: a serialization-conflict error (P2034) is retried, not surfaced to the caller, as long as the retried attempt is itself valid', async (t) => {
	// Same class withdrawal.service.ts itself checks for (matching
	// paypal-finance.service.ts's existing P2002-handling precedent) —
	// imported for real, not mocked, since it carries no DB connection.
	const { Prisma } = await import('@prisma/client');
	let attempts = 0;
	const withdrawals: any[] = [];
	const aggregateSpy = t.mock.fn(async () => ({ _sum: { amount: 0 } }));
	const createSpy = t.mock.fn(async (args: any) => {
		const row = { id: 'withdrawal-1', status: 'PENDING', ...args.data };
		withdrawals.push(row);
		return row;
	});
	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attempts += 1;
		if (attempts === 1) {
			throw new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock. Please retry your transaction', { code: 'P2034', clientVersion: 'test' });
		}
		return fn(tx);
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 500, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	const result = await withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(result.amount, 200);
	assert.equal(transactionSpy.mock.callCount(), 2, 'the first (conflicted) attempt is retried exactly once here, succeeding on the second');
	assert.equal(createSpy.mock.callCount(), 1, 'only the successful retry actually creates a row');
});

// ============================================================================
// Financial Safety Batch 2A — the confirmed Prisma 7 driver-adapter
// (@prisma/adapter-pg) error shape for the SAME real-DEV-Postgres-verified
// conflict as the P2034 test above: a DriverAdapterError whose cause.kind is
// 'TransactionWriteConflict', which the pre-Batch-2A retry check did not
// recognize at all. Real DriverAdapterError instances are constructed below
// (not duck-typed plain objects), matching isRetryableTransactionConflict's
// own predicate tests.
// ============================================================================

test('createForProvider: a DriverAdapterError (cause.kind = TransactionWriteConflict) is retried, not surfaced to the caller, as long as the retried attempt is itself valid', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let attempts = 0;
	const withdrawals: any[] = [];
	const aggregateSpy = t.mock.fn(async () => ({ _sum: { amount: 0 } }));
	const createSpy = t.mock.fn(async (args: any) => {
		const row = { id: 'withdrawal-1', status: 'PENDING', ...args.data };
		withdrawals.push(row);
		return row;
	});
	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attempts += 1;
		if (attempts === 1) {
			throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		}
		return fn(tx);
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 500, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	const result = await withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(result.amount, 200);
	assert.equal(transactionSpy.mock.callCount(), 2, 'the first (conflicted) attempt is retried exactly once here, succeeding on the second');
	assert.equal(createSpy.mock.callCount(), 1, 'only the successful retry actually creates a row');
});

test('createForProvider: an UNRELATED DriverAdapterError is never retried — it propagates immediately on the first attempt', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let attempts = 0;
	const transactionSpy = t.mock.fn(async () => {
		attempts += 1;
		throw new DriverAdapterError({ kind: 'DatabaseNotReachable' });
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 500, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.cause?.kind ?? err.constructor?.name, 'DatabaseNotReachable'); return true; }
	);
	assert.equal(attempts, 1, 'an unrecognized conflict shape must never be retried — it propagates on the very first attempt');
});

test('createForProvider: on retry, released earnings AND pending withdrawals are re-read fresh — never reusing the first attempt\'s stale values', async (t) => {
	// A real Postgres SERIALIZABLE conflict is detected at COMMIT time — the
	// callback's queries (getWallet, aggregate, and even create()) already
	// ran to completion inside the doomed transaction before Postgres
	// aborts it. This mock reflects that: attempt 1's `fn(tx)` genuinely
	// runs (reading a stale pendingSum of 0), and only AFTER it resolves
	// does the wrapper simulate the commit-time conflict — exactly what
	// Batch 1's real-DEV-Postgres testing observed. The retry then must
	// re-read everything fresh, seeing the now-current pendingSum of 450.
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let transactionAttempt = 0;
	let walletCallCount = 0;
	const aggregateSpy = t.mock.fn(async () => ({ _sum: { amount: transactionAttempt === 1 ? 0 : 450 } }));
	const createSpy = t.mock.fn(async (args: any) => ({ id: 'withdrawal-1', status: 'PENDING', ...args.data }));
	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		transactionAttempt += 1;
		const attemptNumber = transactionAttempt;
		const result = await fn(tx);
		if (attemptNumber === 1) {
			// Simulates Postgres aborting THIS transaction at commit — the
			// callback's own create() above did run and returned a value,
			// but none of it actually persisted; the whole transaction rolls
			// back and $transaction() surfaces the conflict instead of
			// resolving with that value.
			throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		}
		return result;
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: {
			providerFinanceService: {
				getWallet: async () => { walletCallCount += 1; return { summary: { availableBalance: 500, currency: 'USD' } }; }
			}
		}
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	// 500 available, 450 now pending (only visible on retry) -> only 50 left,
	// so a 200 request must correctly fail with the BUSINESS error — proving
	// this is genuinely re-validated on retry, not a stale-balance re-insert.
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		/يتجاوز رصيدك الصافي/
	);
	assert.equal(walletCallCount, 2, 'getWallet() (released earnings) is called again on the retried attempt, not reused from the first');
	assert.equal(aggregateSpy.mock.callCount(), 2, 'the pending-withdrawals aggregate is re-run on the retry too, not reused from the doomed first attempt');
	assert.equal(createSpy.mock.callCount(), 1, 'the doomed first attempt DID call create() (matching real Postgres, which only detects the conflict at commit) — but that attempt never actually committed, and the retry correctly refuses to create a second row once it sees the true, now-insufficient balance');
});

test('createForProvider: if the retry observes insufficient balance, the caller gets the existing clean business error — never the raw technical conflict', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let attempts = 0;
	const aggregateSpy = t.mock.fn(async () => ({ _sum: { amount: 480 } }));
	const createSpy = t.mock.fn(async (args: any) => ({ id: 'withdrawal-1', status: 'PENDING', ...args.data }));
	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attempts += 1;
		if (attempts === 1) throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		return fn(tx);
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 500, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => {
			// The Arabic business AppError, never the raw DriverAdapterError.
			assert.match(err.message, /يتجاوز رصيدك الصافي بعد طلبات السحب المعلقة/);
			assert.equal(err.statusCode, 400);
			return true;
		}
	);
	assert.equal(createSpy.mock.callCount(), 0);
});

test('createForProvider: retry is bounded — if every attempt conflicts, the final conflict error propagates instead of retrying forever', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let attempts = 0;
	const transactionSpy = t.mock.fn(async () => {
		attempts += 1;
		throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 500, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.cause?.kind, 'TransactionWriteConflict'); return true; }
	);
	// Bounded at MAX_SERIALIZATION_RETRIES (3) — not infinite.
	assert.equal(attempts, 3, 'exactly 3 attempts are made, all conflicting, before the conflict is finally surfaced to the caller');
});

// ============================================================================
// createForProvider() — request-hygiene / outstanding-withdrawal-reservation
// fix (financial invariant audit). The eligibility aggregate used to sum
// only PENDING withdrawals, so the instant an existing request moved to
// APPROVED/PROCESSING/COMPLETED it silently stopped reserving any balance,
// letting a provider pile up new PENDING requests that could never actually
// be approved. It now sums every NON-REJECTED status — PENDING, APPROVED,
// PROCESSING, COMPLETED — against availableBalance. REJECTED never reserves.
// ============================================================================

test('A. createForProvider: availableBalance 100, create 80 then create 30 -> the second creation is rejected', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 100 });
	await withdrawalService.createForProvider('provider-1', { amount: 80, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
});

test('B. createForProvider: availableBalance 100, existing APPROVED 80, create 30 -> rejected', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 100, seedWithdrawals: [{ userId: 'provider-1', amount: 80, status: 'APPROVED' }] });
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
});

test('C. createForProvider: availableBalance 100, existing PROCESSING 80, create 30 -> rejected', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 100, seedWithdrawals: [{ userId: 'provider-1', amount: 80, status: 'PROCESSING' }] });
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
});

test('D. createForProvider: availableBalance 100, existing COMPLETED 80, create 30 -> rejected', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 100, seedWithdrawals: [{ userId: 'provider-1', amount: 80, status: 'COMPLETED' }] });
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
});

test('D2. Payout P3-A: createForProvider: availableBalance 100, existing REVERSED 80, create 30 -> rejected — a reversed payout must NOT free its earnings for a second withdrawal', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 100, seedWithdrawals: [{ userId: 'provider-1', amount: 80, status: 'REVERSED' }] });
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
});

test('E. createForProvider: availableBalance 100, existing REJECTED 80, create 30 -> allowed (REJECTED never reserves balance)', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 100, seedWithdrawals: [{ userId: 'provider-1', amount: 80, status: 'REJECTED' }] });
	const result = await withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(result.amount, 30);
	assert.equal(createSpy.mock.callCount(), 1);
});

test('F. createForProvider: availableBalance 100, existing APPROVED 60 + existing PENDING 40 (outstanding already = 100), any positive new withdrawal is rejected', async (t) => {
	const { withdrawalService } = await loadService(t, {
		availableBalance: 100,
		seedWithdrawals: [
			{ userId: 'provider-1', amount: 60, status: 'APPROVED' },
			{ userId: 'provider-1', amount: 40, status: 'PENDING' }
		]
	});
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 1, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
});

test('G. createForProvider: availableBalance 100, existing APPROVED 60 + existing REJECTED 40, create 40 -> allowed (only the APPROVED 60 reserves; REJECTED 40 is excluded)', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, {
		availableBalance: 100,
		seedWithdrawals: [
			{ userId: 'provider-1', amount: 60, status: 'APPROVED' },
			{ userId: 'provider-1', amount: 40, status: 'REJECTED' }
		]
	});
	const result = await withdrawalService.createForProvider('provider-1', { amount: 40, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(result.amount, 40);
	assert.equal(createSpy.mock.callCount(), 1);
});

test('H. createForProvider: existing outstanding total + new amount exactly equals availableBalance -> allowed (inclusive boundary)', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, {
		availableBalance: 100,
		seedWithdrawals: [{ userId: 'provider-1', amount: 70, status: 'PENDING' }]
	});
	const result = await withdrawalService.createForProvider('provider-1', { amount: 30, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(result.amount, 30);
	assert.equal(createSpy.mock.callCount(), 1);
});

test('createForProvider: the outstanding-withdrawals aggregate explicitly includes PENDING, APPROVED, PROCESSING, COMPLETED, REVERSED and excludes REJECTED', async (t) => {
	const { withdrawalService, aggregateSpy } = await loadService(t, { availableBalance: 500 });
	await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(aggregateSpy.mock.callCount(), 1);
	const statusFilter = aggregateSpy.mock.calls[0].arguments[0].where.status;
	assert.ok(statusFilter && Array.isArray(statusFilter.in), 'must be an `in` filter, not a single-status equality check');
	const included = [...statusFilter.in].sort();
	// Payout P3-A hardening: REVERSED (a COMPLETED payout PayPal later took
	// back) must reserve its earnings exactly like COMPLETED does — a
	// reversal must never behave like REJECTED and silently free the same
	// earnings for a second withdrawal.
	assert.deepEqual(included, ['APPROVED', 'COMPLETED', 'PENDING', 'PROCESSING', 'REVERSED']);
	assert.ok(!statusFilter.in.includes('REJECTED'), 'REJECTED must never be included — it never reserves balance');
});

// I. SERIALIZABLE retry for P2034/DriverAdapterError conflicts remains
// correct with the widened aggregate: already exercised and reverified
// green above by the pre-existing 'a serialization-conflict error (P2034)
// is retried...' and 'a DriverAdapterError (cause.kind =
// TransactionWriteConflict) is retried...' tests, which are unaffected by
// this fix's query shape change (they never seed a non-PENDING row).

test('J. createForProvider: on retry, the WIDENED outstanding-total aggregate is recalculated from fresh state — a competing withdrawal that became APPROVED between attempts is correctly seen (not just re-reading stale PENDING data)', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	let transactionAttempt = 0;
	// availableBalance 100; a competing withdrawal (60, APPROVED) exists only
	// from the SECOND attempt onward — modeling it having committed between
	// our attempt 1 and attempt 2, exactly like Batch 2A's own precedent.
	const aggregateSpy = t.mock.fn(async () => ({ _sum: { amount: transactionAttempt === 1 ? 0 : 60 } }));
	const createSpy = t.mock.fn(async (args: any) => ({ id: 'withdrawal-1', status: 'PENDING', ...args.data }));
	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		transactionAttempt += 1;
		const attemptNumber = transactionAttempt;
		const result = await fn(tx);
		if (attemptNumber === 1) {
			throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		}
		return result;
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 100, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	// 100 available, 60 now outstanding (only visible on retry) -> only 40
	// left, so a 50 request must correctly fail with the BUSINESS error,
	// proving the retry re-reads the widened aggregate rather than reusing
	// attempt 1's stale (PENDING-only, zero) view.
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 50, method: 'bank_transfer', iban: 'SA0000000000000000000000' }),
		/يتجاوز رصيدك الصافي/
	);
	assert.equal(aggregateSpy.mock.callCount(), 2, 'the outstanding-total aggregate is re-run on the retried attempt, not reused from the doomed first attempt');
	assert.equal(createSpy.mock.callCount(), 1, 'the doomed first attempt DID call create() (matching real Postgres, which only detects the conflict at commit) — but the retry correctly refuses once it sees the true, now-insufficient balance');
});

// ============================================================================
// createForProvider() / approve() — WalletTransaction.referenceId
// defense-in-depth (financial invariant audit follow-up). Withdrawal.referenceId
// used to be left null forever (nothing populated it), so
// WalletTransaction.referenceId's existing @unique constraint provided zero
// real protection — Postgres permits unlimited NULLs in a unique column.
// createForProvider() now generates a real Withdrawal.id up front and
// derives a deterministic, namespaced referenceId from it
// (deriveWithdrawalReferenceId); approve() is UNCHANGED — it already passed
// `item.referenceId` through to WalletTransaction.referenceId, so it now
// simply forwards a real value instead of always-null.
// ============================================================================

test('A. createForProvider: a newly-created Withdrawal has a non-null, deterministic referenceId', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 500 });
	const result = await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.ok(result.referenceId, 'referenceId must be non-null for a newly-created withdrawal');
	assert.equal(typeof result.referenceId, 'string');
});

test('B. createForProvider: the referenceId is derived from the withdrawal\'s own id and follows the "withdrawal-{id}" namespace convention', async (t) => {
	const { deriveWithdrawalReferenceId } = await import('../utils/withdrawal-reference.util');
	const { withdrawalService } = await loadService(t, { availableBalance: 500 });
	const result = await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(result.referenceId, deriveWithdrawalReferenceId(result.id));
	assert.match(result.referenceId, /^withdrawal-/);
	assert.ok(result.referenceId.includes(result.id), 'the reference must embed the withdrawal\'s own id');
});

test('C. approve(): the WalletTransaction it creates uses EXACTLY the same referenceId the withdrawal was created with — no second, independent reference is generated', async (t) => {
	const { withdrawalService, walletTransactions } = await loadService(t, { availableBalance: 500 });
	const created = await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.ok(created.referenceId);

	await withdrawalService.approve(created.id, 'admin-1', { adminNote: 'ok' });

	assert.equal(walletTransactions.length, 1);
	assert.equal(walletTransactions[0].referenceId, created.referenceId, 'approve() must forward the withdrawal\'s own referenceId unchanged, never mint a new one');
});

test('D. createForProvider: two different withdrawals receive two different referenceIds', async (t) => {
	const { withdrawalService } = await loadService(t, { availableBalance: 500 });
	const first = await withdrawalService.createForProvider('provider-1', { amount: 50, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	const second = await withdrawalService.createForProvider('provider-1', { amount: 50, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.notEqual(first.id, second.id);
	assert.notEqual(first.referenceId, second.referenceId);
});

test('E/F. createForProvider: on a SERIALIZABLE retry, the SAME id/referenceId pair is reused across every attempt of one logical creation call — never a fresh id per attempt, and never more than one row ever persists', async (t) => {
	const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
	const { deriveWithdrawalReferenceId } = await import('../utils/withdrawal-reference.util');
	let attempts = 0;
	const seenIds: string[] = [];
	const aggregateSpy = t.mock.fn(async () => ({ _sum: { amount: 0 } }));
	const createSpy = t.mock.fn(async (args: any) => {
		seenIds.push(args.data.id);
		return { status: 'PENDING', ...args.data };
	});
	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attempts += 1;
		if (attempts === 1) throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		return fn(tx);
	});
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, providerProfile: { findUnique: async () => ({ iban: 'SA-STORED-0000', accountHolder: 'Stored Holder' }) } } } });
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 500, currency: 'USD' } }) } }
	});
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);

	const result = await withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(transactionSpy.mock.callCount(), 2, 'the first (conflicted) attempt is retried exactly once, succeeding on the second');
	assert.equal(createSpy.mock.callCount(), 1, 'the doomed first attempt never even reached create() here (it conflicted before running), so only the successful attempt generated a row at all');
	assert.equal(result.referenceId, deriveWithdrawalReferenceId(result.id));
	assert.equal(new Set(seenIds).size, 1, 'no more than one logical withdrawal id/referenceId was ever used for this one successfully-created withdrawal');
});

// ============================================================================
// createForProvider() — Payout P2-A: PayPal destination snapshot. The
// destination is resolved ONCE from the authenticated provider's own
// ProviderProfile.paypalPayoutEmail (never the request body, never
// User.email), then copied onto Withdrawal.paypalEmail at creation time.
// Changing ProviderProfile.paypalPayoutEmail afterward must never alter an
// already-created Withdrawal's snapshot — the mock's providerProfile fixture
// is read once per call and never mutates the created row retroactively,
// which is exactly what a real, separate DB row would do too.
// ============================================================================

test('E. createForProvider: a PayPal withdrawal snapshots ProviderProfile.paypalPayoutEmail onto Withdrawal.paypalEmail', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, {
		availableBalance: 500,
		providerProfile: { paypalPayoutEmail: 'provider@paypal-sandbox.example' }
	});

	const result = await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'paypal' } as any);

	assert.equal(result.paypalEmail, 'provider@paypal-sandbox.example');
	assert.equal(createSpy.mock.calls[0].arguments[0].data.paypalEmail, 'provider@paypal-sandbox.example');
});

test('F. createForProvider: a caller-supplied paypalEmail in the request is silently ignored — the destination always comes from ProviderProfile, never the caller', async (t) => {
	const { withdrawalService } = await loadService(t, {
		availableBalance: 500,
		providerProfile: { paypalPayoutEmail: 'real-provider@paypal-sandbox.example' }
	});

	// Simulates a caller/attacker who somehow got an extra field into the
	// object reaching the service (e.g. bypassing the DTO in a hypothetical
	// future caller) — createForProvider() itself must never read it.
	const result = await withdrawalService.createForProvider('provider-1', {
		amount: 100, method: 'paypal', paypalEmail: 'attacker@evil.example'
	} as any);

	assert.equal(result.paypalEmail, 'real-provider@paypal-sandbox.example', 'the snapshot must come from ProviderProfile, never from anything on the input object');
});

test('G. createForProvider: a PayPal withdrawal is rejected cleanly BEFORE any row is created when the provider has no configured PayPal destination', async (t) => {
	const { withdrawalService, createSpy, transactionSpy } = await loadService(t, { availableBalance: 500 }); // no providerProfile fixture -> findUnique resolves null

	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 100, method: 'paypal' } as any),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
	assert.equal(createSpy.mock.callCount(), 0);
	assert.equal(transactionSpy.mock.callCount(), 0, 'the destination check happens before the transaction/retry loop even starts');
});

test('G2. createForProvider: a PayPal withdrawal is rejected cleanly when ProviderProfile.paypalPayoutEmail is an empty string (the DTO\'s own "cleared" representation)', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, {
		availableBalance: 500,
		providerProfile: { paypalPayoutEmail: '' }
	});

	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 100, method: 'paypal' } as any),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
	assert.equal(createSpy.mock.callCount(), 0);
});

test('H. createForProvider: a PayPal withdrawal does NOT require an IBAN or account number', async (t) => {
	const { withdrawalService } = await loadService(t, {
		availableBalance: 500,
		providerProfile: { paypalPayoutEmail: 'provider@paypal-sandbox.example' }
	});

	// No iban/accountNumber supplied at all — must succeed for method: 'paypal'.
	const result = await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'paypal' } as any);
	assert.equal(result.status, 'PENDING');
	assert.equal(result.accountNumber, null);
	assert.equal(result.iban, null);
});

// I. Requirement "existing bank withdrawal still requires its existing
// destination requirements (preserved)" — this has always been enforced at
// the DTO layer (createWithdrawalSchema's superRefine), never inside
// WithdrawalService itself; the service has never re-validated iban/
// accountNumber presence, relying entirely on the controller-level DTO
// parse having already happened. Asserting this at the service layer would
// test behavior the service never owned, so this is asserted directly
// against the DTO, which is the actual, and unchanged, source of that rule.
test('I. createWithdrawalSchema: a bank_transfer request no longer carries or needs a destination (#32: it comes from the stored profile)', async () => {
	const { createWithdrawalSchema } = await import('../dtos/withdrawal.dto');

	assert.equal(createWithdrawalSchema.safeParse({ amount: 100, method: 'bank_transfer' }).success, true);
	// an IBAN in the body is accepted as noise but dropped by the schema
	const withIban = createWithdrawalSchema.parse({ amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal('iban' in withIban, false);
});

// Final pre-commit review follow-up: the DTO trust-boundary claim ("Zod's
// default non-strict parsing silently drops any key this schema doesn't
// declare") was previously only asserted in a comment and manually verified
// ad hoc — this pins it down as a real regression test against the actual
// schema, independent of and in addition to F's service-level proof that
// createForProvider() itself ignores a paypalEmail on its input object.
test('createWithdrawalSchema: a caller-supplied paypalEmail is stripped at the DTO trust boundary', async () => {
	const { createWithdrawalSchema } = await import('../dtos/withdrawal.dto');

	const result = createWithdrawalSchema.safeParse({
		amount: 100,
		method: 'paypal',
		paypalEmail: 'attacker@evil.example'
	} as any);

	assert.equal(result.success, true);
	if (result.success) {
		assert.equal('paypalEmail' in result.data, false);
	}
});

test('J. createForProvider: a bank_transfer withdrawal leaves Withdrawal.paypalEmail null, even with a ProviderProfile.paypalPayoutEmail on file', async (t) => {
	const { withdrawalService } = await loadService(t, {
		availableBalance: 500,
		providerProfile: { paypalPayoutEmail: 'provider@paypal-sandbox.example' }
	});

	const result = await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(result.paypalEmail, null);
});

test('K. createForProvider: changing ProviderProfile.paypalPayoutEmail AFTER a withdrawal is created does not alter that withdrawal\'s already-snapshotted destination', async (t) => {
	const { withdrawalService, providerProfileFindUniqueSpy } = await loadService(t, {
		availableBalance: 500,
		providerProfile: { paypalPayoutEmail: 'original@paypal-sandbox.example' }
	});

	const first = await withdrawalService.createForProvider('provider-1', { amount: 50, method: 'paypal' } as any);
	assert.equal(first.paypalEmail, 'original@paypal-sandbox.example');

	// Simulate the provider updating their profile afterward — the mock's
	// own fixture changes, exactly like a real, separate ProviderProfile row
	// being updated in place.
	providerProfileFindUniqueSpy.mock.mockImplementation(async () => ({ paypalPayoutEmail: 'changed-later@paypal-sandbox.example' }));

	// The ALREADY-CREATED withdrawal's snapshot must be completely unaffected.
	assert.equal(first.paypalEmail, 'original@paypal-sandbox.example');

	// And a NEW withdrawal created now correctly picks up the NEW value —
	// proving the snapshot is genuinely per-creation-time, not a live pointer.
	const second = await withdrawalService.createForProvider('provider-1', { amount: 50, method: 'paypal' } as any);
	assert.equal(second.paypalEmail, 'changed-later@paypal-sandbox.example');
	assert.equal(first.paypalEmail, 'original@paypal-sandbox.example', 'the first withdrawal must still show its original snapshot');
});

// ============================================================================
// approve() — TWO races closed here, both from the Payout P1 audit:
//
// 1. Same-withdrawal TOCTOU (fixed previously): the unconditional
//    tx.withdrawal.update() is a conditional updateMany({where: {id,
//    status: PENDING}}), count === 1 required before the WalletTransaction
//    is ever written.
//
// 2. Same-provider balance overspend (fixed in THIS batch): the wallet
//    balance read and the "already withdrawn" aggregate used to run OUTSIDE
//    any transaction. Two different PENDING withdrawals for the SAME
//    provider could each independently pass the balance check before either
//    committed, together over-approving. Both reads now run INSIDE the same
//    SERIALIZABLE transaction as the conditional status transition, wrapped
//    in the same bounded-retry loop (reusing isRetryableTransactionConflict,
//    not a weaker P2034-only check) as createForProvider().
//
// The mock below supports BOTH races: `simulateConcurrentWinner`/
// `opponentAction` model the same-row TOCTOU exactly as before (findUnique's
// own callback mutates the "real" row immediately after returning a stale
// snapshot); `otherWithdrawals` + `simulateSerializableConflict` model the
// balance race, letting the transaction callback run to FULL completion
// (including its writes) before a genuine commit-time conflict is raised —
// the same Batch 2A lesson already proven in createForProvider()'s own tests.
// ============================================================================

function createApproveMockPrisma(t: TestContext, opts: {
	initialStatus?: string;
	simulateConcurrentWinner?: boolean;
	opponentAction?: 'APPROVED' | 'REJECTED';
	availableBalance?: number;
	otherWithdrawals?: any[];
	failAfterTransition?: boolean;
	failAfterRejectTransition?: boolean;
	// Simulates a genuine PostgreSQL SERIALIZABLE conflict detected at
	// COMMIT time, for `conflictOnAttempts` of the attempts (1-indexed,
	// e.g. 1 = only the first attempt conflicts then the retry succeeds; 3 =
	// every attempt within MAX_SERIALIZATION_RETRIES conflicts, exhausting
	// the bounded retry). Optionally marks `otherWithdrawals[0]` APPROVED
	// the moment the conflict fires, modeling "we conflicted because a
	// competing approval for this provider's OTHER withdrawal just
	// committed" — so the retry's fresh balance read correctly reflects it.
	simulateSerializableConflict?: { kind: 'P2034' | 'DriverAdapterError'; conflictOnAttempts: number; competingApprovalCommits?: boolean };
} = {}) {
	const row: any = {
		id: 'wd-1', userId: 'provider-1', amount: 200, currency: 'USD', method: 'bank_transfer',
		referenceId: 'ref-1', status: opts.initialStatus ?? 'PENDING'
	};
	const withdrawals: any[] = [row, ...(opts.otherWithdrawals ?? [])];
	const walletTransactions: any[] = [];
	let opponentFired = false;
	let attemptCount = 0;

	const findUniqueSpy = t.mock.fn(async (args: any) => {
		const target = withdrawals.find(w => w.id === args.where.id);
		if (!target) return null;
		const snapshot = { ...target };
		if (target.id === row.id) {
			if (opts.simulateConcurrentWinner) {
				// A concurrent admin's approve() reads AFTER us but commits its
				// whole transaction (conditional update + WalletTransaction)
				// BEFORE our own transaction runs — the real row is now
				// APPROVED, even though the snapshot we return still says PENDING.
				row.status = 'APPROVED';
			}
			if (opts.opponentAction && !opponentFired) {
				// Generalized version of the same interleaving, used for the
				// approve()-vs-reject() mutual-exclusion tests: an opposing
				// decision (the OTHER method) reads first but fully commits its
				// own real side effects before our transaction's conditional
				// update runs. Fires once, mirroring a single opposing call.
				opponentFired = true;
				row.status = opts.opponentAction;
				if (opts.opponentAction === 'APPROVED') {
					walletTransactions.push({ id: `wt-${walletTransactions.length + 1}`, userId: row.userId, type: 'WITHDRAWAL', amount: -row.amount, currency: row.currency, status: 'COMPLETED' });
				}
			}
		}
		return snapshot;
	});
	const aggregateSpy = t.mock.fn(async (args: any) => {
		const statuses: string[] = args.where?.status?.in ?? [];
		const sum = withdrawals
			.filter(w => w.userId === args.where.userId && statuses.includes(w.status))
			.reduce((s, w) => s + w.amount, 0);
		return { _sum: { amount: sum || 0 } };
	});
	const updateManySpy = t.mock.fn(async (args: any) => {
		const target = withdrawals.find(w => w.id === args.where.id);
		if (!target || target.status !== args.where.status) return { count: 0 };
		Object.assign(target, args.data);
		return { count: 1 };
	});
	const findUniqueOrThrowSpy = t.mock.fn(async (args: any) => {
		const target = withdrawals.find(w => w.id === args.where.id);
		if (!target) throw new Error('not found (test mock)');
		if (opts.failAfterRejectTransition && target.status === 'REJECTED') {
			throw new Error('simulated failure after reject\'s conditional transition already succeeded');
		}
		return { ...target };
	});
	const walletTransactionCreateSpy = t.mock.fn(async (args: any) => {
		if (opts.failAfterTransition) throw new Error('simulated failure after the conditional transition succeeded');
		const wt = { id: `wt-${walletTransactions.length + 1}`, ...args.data };
		walletTransactions.push(wt);
		return wt;
	});
	const getWalletSpy = t.mock.fn(async (_userId: string, _client?: unknown) => ({
		summary: { availableBalance: opts.availableBalance ?? 1000, currency: 'USD' }
	}));

	const tx = {
		withdrawal: { aggregate: aggregateSpy, updateMany: updateManySpy, findUniqueOrThrow: findUniqueOrThrowSpy },
		walletTransaction: { create: walletTransactionCreateSpy }
	};
	const transactionSpy = t.mock.fn(async (fn: any) => {
		attemptCount += 1;
		const thisAttempt = attemptCount;
		// Models real Postgres commit-time behavior: the callback (including
		// any writes it makes) runs to FULL completion before we ever decide
		// the transaction failed — a genuine SERIALIZABLE conflict is
		// detected at COMMIT, never before the callback runs.
		//
		// Restoring is done via Object.assign onto the SAME objects (never by
		// swapping in fresh copies) — this preserves object identity, so a
		// test's own held reference (e.g. `row`, which IS withdrawals[0])
		// correctly reflects the rolled-back state too, not a stale mutated
		// object left behind by a swapped-out array.
		const withdrawalsSnapshot = withdrawals.map(w => ({ ...w }));
		const walletSnapshot = [...walletTransactions];
		const restore = () => {
			withdrawals.forEach((w, i) => Object.assign(w, withdrawalsSnapshot[i]));
			walletTransactions.length = 0; walletTransactions.push(...walletSnapshot);
		};
		// Genuine failures from fn(tx) itself (a business AppError, or any
		// other real error) are caught and rolled back HERE, separately from
		// the conflict-simulation branch below — so that branch's own
		// deliberate restore()+override is never re-clobbered by a second,
		// blanket restore() catching its own throw.
		let result: unknown;
		try {
			result = await fn(tx);
		} catch (error) {
			restore();
			throw error;
		}

		const conflictSpec = opts.simulateSerializableConflict;
		if (conflictSpec && thisAttempt <= conflictSpec.conflictOnAttempts) {
			// Roll back everything the (doomed) callback just did...
			restore();
			if (conflictSpec.competingApprovalCommits && withdrawals[1]) {
				// ...except the COMPETING transaction's own commit, which
				// really did land first — this is what the retry's fresh
				// balance read must see.
				withdrawals[1].status = 'APPROVED';
			}
			if (conflictSpec.kind === 'P2034') {
				const { Prisma } = await import('@prisma/client');
				throw new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock. Please retry your transaction', { code: 'P2034', clientVersion: 'test' });
			}
			const { DriverAdapterError } = await import('@prisma/driver-adapter-utils');
			throw new DriverAdapterError({ kind: 'TransactionWriteConflict' });
		}
		return result;
	});

	t.mock.module('../config/db', {
		namedExports: { prisma: {
			$transaction: transactionSpy,
			withdrawal: { findUnique: findUniqueSpy },
			// Release-blocker fix: plain provider owner -> provider-wallet ledger (unchanged behavior).
			user: { findUnique: t.mock.fn(async () => ({ accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null })) }
		} }
	});
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: getWalletSpy } }
	});

	return { row, withdrawals, walletTransactions, findUniqueSpy, aggregateSpy, updateManySpy, findUniqueOrThrowSpy, walletTransactionCreateSpy, getWalletSpy, transactionSpy };
}

async function loadApproveService(t: TestContext, opts?: Parameters<typeof createApproveMockPrisma>[1]) {
	const mocks = createApproveMockPrisma(t, opts);
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);
	return { withdrawalService, ...mocks };
}

test('A. approve: a normal PENDING withdrawal transitions to APPROVED exactly once, with exactly one WalletTransaction debit, and the balance check runs INSIDE the transaction (via tx)', async (t) => {
	const { withdrawalService, updateManySpy, walletTransactionCreateSpy, walletTransactions, getWalletSpy, aggregateSpy, transactionSpy } = await loadApproveService(t);

	const result = await withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' });

	assert.equal(result.status, 'APPROVED');
	assert.equal(updateManySpy.mock.callCount(), 1);
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 1);
	assert.equal(walletTransactions.length, 1);
	assert.equal(walletTransactions[0].amount, -200);
	assert.equal(updateManySpy.mock.calls[0].arguments[0].where.status, 'PENDING');
	// The balance eligibility read is part of the SAME transaction as the
	// conditional update — the fix's core claim — not a read taken before it.
	assert.equal(transactionSpy.mock.callCount(), 1);
	assert.notEqual(getWalletSpy.mock.calls[0].arguments[1], undefined, 'getWallet() must be called with the tx client, not the global prisma client');
	assert.equal(aggregateSpy.mock.callCount(), 1, 'the "already withdrawn" aggregate ran via tx.withdrawal.aggregate, inside the transaction');
});

test('B. approve: two different PENDING withdrawals for the SAME provider, combined amount WITHIN balance — both succeed, exactly two legitimate WalletTransactions exist', async (t) => {
	// Real independent approve() calls, run sequentially (this mock has no
	// genuine thread-level concurrency), sharing ONE underlying withdrawals
	// array + walletTransactions array — mirroring createForProvider()'s own
	// "two concurrent requests" test precedent. availableBalance 500; two
	// withdrawals of 200 each = 400 combined, within balance.
	const withdrawals = [
		{ id: 'wd-1', userId: 'provider-1', amount: 200, currency: 'USD', method: 'bank_transfer', referenceId: 'ref-1', status: 'PENDING' },
		{ id: 'wd-2', userId: 'provider-1', amount: 200, currency: 'USD', method: 'bank_transfer', referenceId: 'ref-2', status: 'PENDING' }
	];
	const walletTransactions: any[] = [];

	async function loadFor(t2: TestContext, withdrawalId: string) {
		const findUniqueSpy = t2.mock.fn(async (args: any) => { const w = withdrawals.find(x => x.id === args.where.id); return w ? { ...w } : null; });
		const aggregateSpy = t2.mock.fn(async (args: any) => {
			const statuses: string[] = args.where?.status?.in ?? [];
			const sum = withdrawals.filter(w => w.userId === args.where.userId && statuses.includes(w.status)).reduce((s, w) => s + w.amount, 0);
			return { _sum: { amount: sum || 0 } };
		});
		const updateManySpy = t2.mock.fn(async (args: any) => {
			const target = withdrawals.find(w => w.id === args.where.id);
			if (!target || target.status !== args.where.status) return { count: 0 };
			Object.assign(target, args.data);
			return { count: 1 };
		});
		const findUniqueOrThrowSpy = t2.mock.fn(async (args: any) => {
			const target = withdrawals.find(w => w.id === args.where.id);
			if (!target) throw new Error('not found');
			return { ...target };
		});
		const walletTransactionCreateSpy = t2.mock.fn(async (args: any) => { const wt = { id: `wt-${walletTransactions.length + 1}`, ...args.data }; walletTransactions.push(wt); return wt; });
		const getWalletSpy = t2.mock.fn(async () => ({ summary: { availableBalance: 500, currency: 'USD' } }));
		const tx = { withdrawal: { aggregate: aggregateSpy, updateMany: updateManySpy, findUniqueOrThrow: findUniqueOrThrowSpy }, walletTransaction: { create: walletTransactionCreateSpy } };
		const transactionSpy = t2.mock.fn(async (fn: any) => fn(tx));
		t2.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, withdrawal: { findUnique: findUniqueSpy }, user: { findUnique: t2.mock.fn(async () => ({ accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null })) } } } });
		t2.mock.module('./provider-finance.service', { namedExports: { providerFinanceService: { getWallet: getWalletSpy } } });
		const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
		const { withdrawalService } = await import(moduleUrl);
		return { withdrawalService, updateManySpy };
	}

	await t.test('approve wd-1', async (t2) => { const { withdrawalService } = await loadFor(t2, 'wd-1'); await withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' }); });
	await t.test('approve wd-2', async (t2) => { const { withdrawalService } = await loadFor(t2, 'wd-2'); await withdrawalService.approve('wd-2', 'admin-1', { adminNote: 'ok' }); });

	assert.equal(withdrawals[0].status, 'APPROVED');
	assert.equal(withdrawals[1].status, 'APPROVED');
	assert.equal(walletTransactions.length, 2, 'both legitimate approvals must each record their own debit');
	assert.equal(walletTransactions.reduce((s, wt) => s + wt.amount, 0), -400);
});

test('C. approve: two different PENDING withdrawals for the SAME provider, combined amount EXCEEDS balance — exactly one succeeds, the other fails cleanly, total approved never exceeds the available balance, exactly one WalletTransaction exists', async (t) => {
	// availableBalance 300; two withdrawals of 200 each = 400 combined,
	// EXCEEDS balance. Whichever commits first legitimately takes the
	// balance; the second's own fresh in-transaction aggregate read must
	// then see it and cleanly refuse — never a raw DB error.
	const withdrawals = [
		{ id: 'wd-1', userId: 'provider-1', amount: 200, currency: 'USD', method: 'bank_transfer', referenceId: 'ref-1', status: 'PENDING' },
		{ id: 'wd-2', userId: 'provider-1', amount: 200, currency: 'USD', method: 'bank_transfer', referenceId: 'ref-2', status: 'PENDING' }
	];
	const walletTransactions: any[] = [];

	async function loadFor(t2: TestContext) {
		const findUniqueSpy = t2.mock.fn(async (args: any) => { const w = withdrawals.find(x => x.id === args.where.id); return w ? { ...w } : null; });
		const aggregateSpy = t2.mock.fn(async (args: any) => {
			const statuses: string[] = args.where?.status?.in ?? [];
			const sum = withdrawals.filter(w => w.userId === args.where.userId && statuses.includes(w.status)).reduce((s, w) => s + w.amount, 0);
			return { _sum: { amount: sum || 0 } };
		});
		const updateManySpy = t2.mock.fn(async (args: any) => {
			const target = withdrawals.find(w => w.id === args.where.id);
			if (!target || target.status !== args.where.status) return { count: 0 };
			Object.assign(target, args.data);
			return { count: 1 };
		});
		const findUniqueOrThrowSpy = t2.mock.fn(async (args: any) => {
			const target = withdrawals.find(w => w.id === args.where.id);
			if (!target) throw new Error('not found');
			return { ...target };
		});
		const walletTransactionCreateSpy = t2.mock.fn(async (args: any) => { const wt = { id: `wt-${walletTransactions.length + 1}`, ...args.data }; walletTransactions.push(wt); return wt; });
		const getWalletSpy = t2.mock.fn(async () => ({ summary: { availableBalance: 300, currency: 'USD' } }));
		const tx = { withdrawal: { aggregate: aggregateSpy, updateMany: updateManySpy, findUniqueOrThrow: findUniqueOrThrowSpy }, walletTransaction: { create: walletTransactionCreateSpy } };
		const transactionSpy = t2.mock.fn(async (fn: any) => fn(tx));
		t2.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy, withdrawal: { findUnique: findUniqueSpy }, user: { findUnique: t2.mock.fn(async () => ({ accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null })) } } } });
		t2.mock.module('./provider-finance.service', { namedExports: { providerFinanceService: { getWallet: getWalletSpy } } });
		const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
		const { withdrawalService } = await import(moduleUrl);
		return { withdrawalService };
	}

	let secondRejected = false;
	await t.test('approve wd-1 (commits first, legitimately takes the balance)', async (t2) => {
		const { withdrawalService } = await loadFor(t2);
		await withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' });
	});
	await t.test('approve wd-2 (its own fresh in-transaction read now sees wd-1 already APPROVED)', async (t2) => {
		const { withdrawalService } = await loadFor(t2);
		try {
			await withdrawalService.approve('wd-2', 'admin-1', { adminNote: 'ok' });
		} catch (err: any) {
			secondRejected = true;
			assert.equal(err.statusCode, 400, 'a clean insufficient-balance business error, not a raw DB conflict');
			assert.equal(err.code, undefined);
		}
	});

	assert.equal(secondRejected, true);
	assert.equal(withdrawals[0].status, 'APPROVED');
	assert.equal(withdrawals[1].status, 'PENDING', 'the second withdrawal must never be approved once it would overspend the balance');
	assert.equal(walletTransactions.length, 1, 'exactly one approval WalletTransaction exists');
	const totalApproved = withdrawals.filter(w => w.status === 'APPROVED').reduce((s, w) => s + w.amount, 0);
	assert.ok(totalApproved <= 300, 'total approved amount must never exceed the provider\'s available balance');
});

test('D. approve: a second/concurrent approval of the SAME withdrawal that loses the race (row already APPROVED by write time) gets a clean conflict error, never a raw DB error, and writes NO second WalletTransaction', async (t) => {
	const { withdrawalService, walletTransactionCreateSpy, updateManySpy } = await loadApproveService(t, { simulateConcurrentWinner: true });

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-2', { adminNote: 'too late' }),
		(err: any) => {
			// Clean, pre-existing Arabic business error — no leaked Prisma/DB
			// error shape (no `.code`, no constraint name, etc.).
			assert.equal(err.statusCode, 409);
			assert.match(err.message, /تمت معالجته مسبقاً/);
			assert.equal(err.code, undefined);
			return true;
		}
	);
	// The conditional update DID run (and correctly matched zero rows) — this
	// proves the race was caught at the write, not merely by luck.
	assert.equal(updateManySpy.mock.callCount(), 1);
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0, 'the loser must never write a WalletTransaction debit');
});

test('E1. approve() vs reject() (same withdrawal): approve wins — final status APPROVED, reject() loses cleanly, exactly one approval WalletTransaction exists', async (t) => {
	const { withdrawalService, row, walletTransactions, updateManySpy } = await loadApproveService(t, { opponentAction: 'APPROVED' });

	await assert.rejects(
		() => withdrawalService.reject('wd-1', 'admin-2', { rejectionReason: 'too late, already approved' }),
		(err: any) => { assert.equal(err.statusCode, 409); return true; }
	);

	assert.equal(row.status, 'APPROVED');
	assert.equal(walletTransactions.length, 1, 'exactly the winning approve()\'s debit — reject() must never add or remove any WalletTransaction');
	assert.equal(walletTransactions[0].amount, -200);
	assert.equal(updateManySpy.mock.callCount(), 1, 'reject()\'s own conditional update ran and correctly matched zero rows');
});

test('E2. approve() vs reject() (same withdrawal): reject wins — final status REJECTED, approve() loses cleanly, zero approval WalletTransactions exist', async (t) => {
	const { withdrawalService, row, walletTransactions, walletTransactionCreateSpy, updateManySpy } = await loadApproveService(t, { opponentAction: 'REJECTED' });

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-2', { adminNote: 'too late, already rejected' }),
		(err: any) => { assert.equal(err.statusCode, 409); return true; }
	);

	assert.equal(row.status, 'REJECTED');
	assert.equal(walletTransactions.length, 0, 'the losing approve() must never write a debit for a withdrawal that was actually rejected');
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0);
	assert.equal(updateManySpy.mock.callCount(), 1, 'approve()\'s own conditional update ran and correctly matched zero rows');
});

test('F. approve: a P2034/DriverAdapterError serialization conflict is retried transparently, succeeding on the retried attempt, using the existing bounded retry policy', async (t) => {
	for (const kind of ['P2034', 'DriverAdapterError'] as const) {
		await t.test(kind, async (t2) => {
			const { withdrawalService, transactionSpy, walletTransactions } = await loadApproveService(t2, {
				simulateSerializableConflict: { kind, conflictOnAttempts: 1 }
			});
			const result = await withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' });
			assert.equal(result.status, 'APPROVED');
			assert.equal(transactionSpy.mock.callCount(), 2, 'the first (conflicted) attempt is retried exactly once here, succeeding on the second');
			assert.equal(walletTransactions.length, 1, 'only the successful retry actually wrote a debit');
		});
	}
});

test('Payout P3-A: approve: a REVERSED withdrawal reserves its earnings — approving a DIFFERENT withdrawal that would exceed the remaining balance is rejected', async (t) => {
	// wd-1 (200, PENDING, being approved) vs an already-REVERSED wd-2 (100)
	// for the SAME provider, availableBalance 250. The REVERSED 100 must
	// still count as outstanding, leaving only 150 withdrawable — wd-1's 200
	// must be rejected, exactly as it would be if wd-2 were still COMPLETED
	// (never as if wd-2 were REJECTED, which would free the full 250).
	const { withdrawalService, walletTransactions } = await loadApproveService(t, {
		availableBalance: 250,
		otherWithdrawals: [{ id: 'wd-2', userId: 'provider-1', amount: 100, currency: 'USD', method: 'bank_transfer', referenceId: 'ref-2', status: 'REVERSED' }]
	});

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' }),
		(err: any) => { assert.equal(err.statusCode, 400); return true; }
	);
	assert.equal(walletTransactions.length, 0, 'no debit may occur for an approval that would exceed the balance once REVERSED earnings stay reserved');
});

test('G. approve: after a retry, the balance is recalculated fresh from the newly committed state — never reusing the doomed first attempt\'s stale reads', async (t) => {
	// wd-1 (200) vs a competing wd-2 (200) for the SAME provider, balance 300.
	// Attempt 1 conflicts at commit; the SAME conflict models the competing
	// approval of wd-2 having actually landed first. The retry's fresh
	// aggregate read must see wd-2 as APPROVED and correctly refuse wd-1 —
	// proving the retry re-reads rather than reusing attempt 1's stale view.
	const { withdrawalService, aggregateSpy, walletTransactions } = await loadApproveService(t, {
		availableBalance: 300,
		otherWithdrawals: [{ id: 'wd-2', userId: 'provider-1', amount: 200, currency: 'USD', method: 'bank_transfer', referenceId: 'ref-2', status: 'PENDING' }],
		simulateSerializableConflict: { kind: 'DriverAdapterError', conflictOnAttempts: 1, competingApprovalCommits: true }
	});

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' }),
		(err: any) => { assert.equal(err.statusCode, 400); assert.equal(err.code, undefined); return true; }
	);
	assert.equal(aggregateSpy.mock.callCount(), 2, 'the aggregate is re-run on the retried attempt, not reused from the doomed first attempt');
	assert.equal(walletTransactions.length, 0, 'wd-1 must never be approved once the retry\'s fresh read shows the balance is already spoken for');
});

test('H. approve: the SERIALIZABLE retry is bounded — if every attempt conflicts, a clean application-level error propagates rather than retrying forever or leaking raw DB internals', async (t) => {
	const { withdrawalService, transactionSpy } = await loadApproveService(t, {
		simulateSerializableConflict: { kind: 'DriverAdapterError', conflictOnAttempts: 3 }
	});

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' }),
		(err: any) => {
			// The raw DriverAdapterError itself propagates (matching
			// createForProvider()'s own exhausted-retry precedent) — it is
			// already a structured, typed error, not a leaked SQL string or
			// stack trace, and callers upstream already handle it generically.
			assert.equal(err.cause?.kind, 'TransactionWriteConflict');
			return true;
		}
	);
	// Bounded at MAX_SERIALIZATION_RETRIES (3) — not infinite.
	assert.equal(transactionSpy.mock.callCount(), 3, 'exactly 3 attempts are made, all conflicting, before the conflict is finally surfaced to the caller');
});

test('I. approve: if the WalletTransaction write fails AFTER the conditional transition already succeeded, the whole transaction rolls back — the withdrawal is not left APPROVED', async (t) => {
	const { withdrawalService, row, walletTransactions } = await loadApproveService(t, { failAfterTransition: true });

	await assert.rejects(() => withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' }));

	assert.equal(row.status, 'PENDING', 'the conditional transition must be rolled back along with everything else in the transaction');
	assert.equal(walletTransactions.length, 0);
});

test('approve: an already non-PENDING withdrawal (checked before any transaction attempt) is rejected and never reaches $transaction at all', async (t) => {
	const { withdrawalService, transactionSpy } = await loadApproveService(t, { initialStatus: 'REJECTED' });

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'x' }),
		(err: any) => { assert.equal(err.statusCode, 409); return true; }
	);
	assert.equal(transactionSpy.mock.callCount(), 0, 'existing authorization/validation behavior is preserved: an already-resolved request is rejected before any transaction starts');
});

test('approve: insufficient withdrawable balance (existing validation, preserved) is rejected — now correctly evaluated INSIDE the transaction, on the first attempt, with no retry (a plain AppError is not a retryable conflict)', async (t) => {
	const { withdrawalService, transactionSpy } = await loadApproveService(t, { availableBalance: 100 });
	// row.amount is 200 > withdrawableBalance (100) -> must fail the existing check.
	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'x' }),
		(err: any) => { assert.equal(err.statusCode, 400); assert.equal(err.code, undefined); return true; }
	);
	assert.equal(transactionSpy.mock.callCount(), 1, 'the balance check now runs inside the transaction, so exactly one attempt is made — a business AppError is never retried');
});

test('approve: a non-existent withdrawal id is rejected with 404 (existing validation, preserved)', async (t) => {
	const { withdrawalService } = await loadApproveService(t);
	await assert.rejects(
		() => withdrawalService.approve('does-not-exist', 'admin-1', { adminNote: 'x' }),
		(err: any) => { assert.equal(err.statusCode, 404); return true; }
	);
});

// ============================================================================
// reject() — the same TOCTOU race, now closed the same way as approve():
// the unconditional tx.withdrawal.update() is replaced with a conditional
// updateMany({where: {id, status: PENDING}}), count === 1 required, and the
// whole transaction rolls back on a losing race. reject() has no related
// audit/side-effect write beyond the transition itself, so there is nothing
// to sequence after it (unlike approve()'s WalletTransaction).
//
// Because approve() and reject() both gate their conditional write on the
// identical `status: PENDING` predicate for the same row, they are also
// mutually exclusive of EACH OTHER — tests further below exercise exactly
// that (an approve()-vs-reject() race), reusing the same opponentAction
// interleaving technique as the approve()-vs-approve() test above.
// ============================================================================

test('A. reject: a normal PENDING withdrawal transitions to REJECTED exactly once', async (t) => {
	const { withdrawalService, updateManySpy, row } = await loadApproveService(t);

	const result = await withdrawalService.reject('wd-1', 'admin-1', { rejectionReason: 'بيانات الحساب غير صحيحة' });

	assert.equal(result.status, 'REJECTED');
	assert.equal(row.status, 'REJECTED');
	assert.equal(updateManySpy.mock.callCount(), 1);
	assert.equal(updateManySpy.mock.calls[0].arguments[0].where.status, 'PENDING');
	assert.equal(updateManySpy.mock.calls[0].arguments[0].data.rejectionReason, 'بيانات الحساب غير صحيحة');
});

test('B. reject: a second/concurrent reject() that loses the race (row already REJECTED by write time) gets a clean 409, no raw DB error, and no duplicate side effect', async (t) => {
	const { withdrawalService, updateManySpy } = await loadApproveService(t, { opponentAction: 'REJECTED' });

	await assert.rejects(
		() => withdrawalService.reject('wd-1', 'admin-2', { rejectionReason: 'too late' }),
		(err: any) => {
			assert.equal(err.statusCode, 409);
			assert.match(err.message, /تمت معالجته مسبقاً/);
			assert.equal(err.code, undefined);
			return true;
		}
	);
	// The conditional update DID run and correctly matched zero rows — the
	// race was caught at the write, not merely by luck of read ordering.
	assert.equal(updateManySpy.mock.callCount(), 1);
});

test('C. approve() vs reject(): approve wins — final status APPROVED, reject() loses cleanly, exactly one approval WalletTransaction exists', async (t) => {
	const { withdrawalService, row, walletTransactions, updateManySpy } = await loadApproveService(t, { opponentAction: 'APPROVED' });

	await assert.rejects(
		() => withdrawalService.reject('wd-1', 'admin-2', { rejectionReason: 'too late, already approved' }),
		(err: any) => { assert.equal(err.statusCode, 409); return true; }
	);

	assert.equal(row.status, 'APPROVED');
	assert.equal(walletTransactions.length, 1, 'exactly the winning approve()\'s debit — reject() must never add or remove any WalletTransaction');
	assert.equal(walletTransactions[0].amount, -200);
	assert.equal(updateManySpy.mock.callCount(), 1, 'reject()\'s own conditional update ran and correctly matched zero rows');
});

test('D. approve() vs reject(): reject wins — final status REJECTED, approve() loses cleanly, zero approval WalletTransactions exist', async (t) => {
	const { withdrawalService, row, walletTransactions, walletTransactionCreateSpy, updateManySpy } = await loadApproveService(t, { opponentAction: 'REJECTED' });

	await assert.rejects(
		() => withdrawalService.approve('wd-1', 'admin-2', { adminNote: 'too late, already rejected' }),
		(err: any) => { assert.equal(err.statusCode, 409); return true; }
	);

	assert.equal(row.status, 'REJECTED');
	assert.equal(walletTransactions.length, 0, 'the losing approve() must never write a debit for a withdrawal that was actually rejected');
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0);
	assert.equal(updateManySpy.mock.callCount(), 1, 'approve()\'s own conditional update ran and correctly matched zero rows');
});

test('E. reject: a failure occurring after the conditional transition already succeeded rolls back the whole transaction — the withdrawal is restored to PENDING, no side effect survives', async (t) => {
	const { withdrawalService, row } = await loadApproveService(t, { failAfterRejectTransition: true });

	await assert.rejects(() => withdrawalService.reject('wd-1', 'admin-1', { rejectionReason: 'x' }));

	assert.equal(row.status, 'PENDING', 'the conditional transition must be rolled back along with everything else in the transaction');
});

test('reject: an already non-PENDING withdrawal is rejected and never reaches $transaction at all (existing validation, preserved)', async (t) => {
	const { withdrawalService, transactionSpy } = await loadApproveService(t, { initialStatus: 'APPROVED' });

	await assert.rejects(
		() => withdrawalService.reject('wd-1', 'admin-1', { rejectionReason: 'x' }),
		(err: any) => { assert.equal(err.statusCode, 409); return true; }
	);
	assert.equal(transactionSpy.mock.callCount(), 0);
});

test('reject: a non-existent withdrawal id is rejected with 404 (existing validation, preserved)', async (t) => {
	const { withdrawalService } = await loadApproveService(t);
	await assert.rejects(
		() => withdrawalService.reject('does-not-exist', 'admin-1', { rejectionReason: 'x' }),
		(err: any) => { assert.equal(err.statusCode, 404); return true; }
	);
});

test('reject: a rejected withdrawal does not permanently consume available earnings — a subsequent full-amount request succeeds once the first is REJECTED', async (t) => {
	// reject() only flips Withdrawal.status; it never touched any balance
	// field to begin with (approve() doesn't either — see
	// provider-finance.service.ts's computed-balance design), so this is
	// the current, intended semantics: availableBalance is always derived
	// fresh from Escrow.releasedAmount, and createForProvider()'s pending-sum
	// only ever counts status: PENDING — a REJECTED row is excluded the
	// moment it's rejected, with nothing to "restore".
	const { withdrawalService } = await loadService(t, { availableBalance: 500 });

	const first = await withdrawalService.createForProvider('provider-1', { amount: 400, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(first.status, 'PENDING');

	// While the first is still PENDING, a second full-amount request must
	// still correctly fail (only 100 left).
	await assert.rejects(() => withdrawalService.createForProvider('provider-1', { amount: 400, method: 'bank_transfer', iban: 'SA0000000000000000000000' }));

	// Reject the first via the real (unchanged) reject() — sharing the same
	// mock withdrawals array as createForProvider() above.
	const rejected = await withdrawalService.reject(first.id, 'admin-1', { rejectionReason: 'بيانات الحساب غير صحيحة' });
	assert.equal(rejected.status, 'REJECTED');

	// Now the full 400 is fundable again — nothing needed to be explicitly
	// "restored", since the rejected row simply stopped being counted.
	const second = await withdrawalService.createForProvider('provider-1', { amount: 400, method: 'bank_transfer', iban: 'SA0000000000000000000000' });
	assert.equal(second.status, 'PENDING');
	assert.equal(second.amount, 400);
});

// ============================================================================
// createForMarketer — P-LG-012 withdrawal-minimum floor (300), enforced via
// Math.max(affiliate.minimumPayoutAmount, 300) regardless of any
// lower per-affiliate custom minimumPayoutAmount value. A higher custom
// value is still respected (Math.max never lowers it).
// ============================================================================

function createMarketerWithdrawalMockPrisma(t: TestContext, opts: {
	minimumPayoutAmount?: number;
	availableCommissions?: number;
	iban?: string | null;
	isProvider?: boolean;
} = {}) {
	const affiliate = {
		id: 'affiliate-1',
		iban: opts.iban === undefined ? 'SA0000000000000000000000' : opts.iban,
		bankName: 'Test Bank',
		accountHolderName: 'Test Affiliate',
		minimumPayoutAmount: opts.minimumPayoutAmount ?? 300
	};
	const withdrawals: any[] = [];
	const createSpy = t.mock.fn(async (args: any) => {
		const row = { id: `withdrawal-${withdrawals.length + 1}`, status: 'PENDING', ...args.data };
		withdrawals.push(row);
		return row;
	});
	const commissionAggregateSpy = t.mock.fn(async () => ({ _sum: { amount: opts.availableCommissions ?? 10000 } }));
	const withdrawalAggregateSpy = t.mock.fn(async () => ({ _sum: { amount: 0 } }));

	const tx = {
		commissionLog: { aggregate: commissionAggregateSpy },
		withdrawal: { aggregate: withdrawalAggregateSpy, create: createSpy }
	};

	const prismaMock: any = {
		affiliateProfile: { findUnique: t.mock.fn(async () => affiliate) },
		user: { findUnique: t.mock.fn(async () => ({ accountType: opts.isProvider ? 'PROVIDER_INDIVIDUAL' : 'MARKETING_BROKER', roles: opts.isProvider ? ['PROVIDER'] : ['AFFILIATE'], activeRole: opts.isProvider ? 'PROVIDER' : 'AFFILIATE' })) },
		$transaction: t.mock.fn(async (fn: any) => fn(tx))
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

	return { createSpy, commissionAggregateSpy };
}

async function loadServiceForMarketer(t: TestContext, opts?: Parameters<typeof createMarketerWithdrawalMockPrisma>[1]) {
	const mocks = createMarketerWithdrawalMockPrisma(t, opts);
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);
	return { withdrawalService, ...mocks };
}

test('createForMarketer: an amount below the 300 floor is rejected even though it exceeds the affiliate\'s own lower custom minimumPayoutAmount', async (t) => {
	const { withdrawalService, createSpy } = await loadServiceForMarketer(t, { minimumPayoutAmount: 100 });

	// 150 clears the affiliate's own custom minimum (100) but not the new
	// P-LG-012 floor (300) — must now be rejected where it previously would
	// have succeeded.
	await assert.rejects(
		() => withdrawalService.createForMarketer('user-1', { amount: 150 }),
		(err: any) => { assert.equal(err.statusCode, 400); assert.match(err.message, /300/); return true; }
	);
	assert.equal(createSpy.mock.callCount(), 0);
});

test('createForMarketer: an amount that meets the 300 floor succeeds (custom minimum lower than 300)', async (t) => {
	const { withdrawalService, createSpy } = await loadServiceForMarketer(t, { minimumPayoutAmount: 100 });

	const result = await withdrawalService.createForMarketer('user-1', { amount: 300 });

	assert.equal(result.amount, 300);
	assert.equal(createSpy.mock.callCount(), 1);
});

test('createForMarketer: a higher custom minimumPayoutAmount is still respected — Math.max never LOWERS the effective floor', async (t) => {
	const { withdrawalService, createSpy } = await loadServiceForMarketer(t, { minimumPayoutAmount: 500 });

	await assert.rejects(
		() => withdrawalService.createForMarketer('user-1', { amount: 400 }),
		(err: any) => { assert.equal(err.statusCode, 400); assert.match(err.message, /500/); return true; }
	);
	assert.equal(createSpy.mock.callCount(), 0);

	const result = await withdrawalService.createForMarketer('user-1', { amount: 500 });
	assert.equal(result.amount, 500);
});

test('createForMarketer: the default minimumPayoutAmount (300, per the updated schema default) enforces exactly 300 as the floor', async (t) => {
	const { withdrawalService, createSpy } = await loadServiceForMarketer(t, { minimumPayoutAmount: 300 });

	await assert.rejects(() => withdrawalService.createForMarketer('user-1', { amount: 299.99 }));
	assert.equal(createSpy.mock.callCount(), 0);

	const result = await withdrawalService.createForMarketer('user-1', { amount: 300 });
	assert.equal(result.amount, 300);
});

// ── USD only: the withdrawal service source carries no riyal/SAR wording and always passes currency USD ──
test('withdrawal.service.ts has no riyal/SAR text and creates both provider and marketer rows with currency USD', () => {
	const src = readFileSync(new URL('./withdrawal.service.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), /ريال|ر\.س|﷼|'SAR'|"SAR"/);
	assert.equal((src.match(/currency: 'USD'/g) || []).length >= 2, true);
});


// ---- Finance #32: the bank destination comes ONLY from the stored profile, never from the request body --------------------------
test('#32 createForProvider: an IBAN / account sent in the body is never used — the stored profile data is the destination', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 500, bankProfile: { iban: 'SA-STORED-1111', accountHolder: 'Stored Holder' } });

	await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA-ATTACKER-9999', accountName: 'Attacker', accountNumber: '999' } as any);

	const data = createSpy.mock.calls[0].arguments[0].data;
	assert.equal(data.iban, 'SA-STORED-1111');
	assert.equal(data.accountName, 'Stored Holder');
	assert.equal(data.accountNumber, null);
	assert.ok(!JSON.stringify(data).includes('ATTACKER') && !JSON.stringify(data).includes('Attacker'));
});

test('#32 createForProvider: with no stored bank data the withdrawal is refused (400, Arabic) even if the body carries an IBAN, and nothing is created', async (t) => {
	// one TestContext per case: t.mock.module() may mock a specifier only once per context
	for (const [i, bankProfile] of ([null, { iban: null }, { iban: '   ' }] as any[]).entries()) {
		await t.test(`stored bank data case ${i}`, async (t2) => {
			const { withdrawalService, createSpy } = await loadService(t2, { availableBalance: 500, bankProfile });
			await assert.rejects(
				() => withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer', iban: 'SA0000000000000000000000' } as any),
				(e: any) => e.statusCode === 400 && e.message === 'لا توجد بيانات بنكية معتمدة للسحب'
			);
			assert.equal(createSpy.mock.callCount(), 0);
		});
	}
});

test('#32 the request schema carries no bank fields (zod drops them) and no longer demands an IBAN', async () => {
	const { createWithdrawalSchema } = await import('../dtos/withdrawal.dto');
	const parsed = createWithdrawalSchema.parse({ amount: 50, iban: 'SA-X', accountName: 'x', accountNumber: '1' });
	assert.deepEqual(parsed, { amount: 50, method: 'bank_transfer' });
	assert.equal(createWithdrawalSchema.safeParse({ amount: 50, method: 'paypal' }).success, true);
});


// ---- Finance #33: PayPal withdrawals are frozen for 24 hours after the payout email was changed ----------------------------------
test('#33 createForProvider(paypal): within 24 hours of a PayPal email change the withdrawal is refused (Arabic) and nothing is created', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 500, providerProfile: { paypalPayoutEmail: 'new@paypal.example' }, paypalEmailChangedAt: new Date(Date.now() - 60 * 60 * 1000) });
	await assert.rejects(
		() => withdrawalService.createForProvider('provider-1', { amount: 100, method: 'paypal' } as any),
		(e: any) => e.statusCode === 400 && e.message === 'تم تغيير بريد PayPal مؤخرًا، يمكن السحب بعد مرور 24 ساعة'
	);
	assert.equal(createSpy.mock.callCount(), 0);
});

test('#33 createForProvider(paypal): after 24 hours the withdrawal is allowed again, to the stored PayPal email', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 500, providerProfile: { paypalPayoutEmail: 'new@paypal.example' }, paypalEmailChangedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
	await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'paypal' } as any);
	assert.equal(createSpy.mock.calls[0].arguments[0].data.paypalEmail, 'new@paypal.example');
});

test('#33 the freeze does not touch the bank method', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 500, paypalEmailChangedAt: new Date(Date.now() - 60 * 1000) });
	await withdrawalService.createForProvider('provider-1', { amount: 100, method: 'bank_transfer' } as any);
	assert.equal(createSpy.mock.callCount(), 1);
});
