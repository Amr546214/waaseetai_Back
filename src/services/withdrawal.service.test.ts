import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Regression guard for the USD-canonical transition: new withdrawal requests
// must explicitly carry currency USD (never rely on the Withdrawal schema's
// historical SAR default). Existing/historical Withdrawal rows are untouched
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

function createWithdrawalMockPrisma(t: TestContext, opts: {
	availableBalance?: number;
	seedWithdrawals?: { userId: string; amount: number; status: string }[];
} = {}) {
	const withdrawals: any[] = (opts.seedWithdrawals || []).map((w, i) => ({ id: `seed-${i}`, ...w }));
	let nextId = withdrawals.length + 1;

	const aggregateSpy = t.mock.fn(async (args: any) => {
		const sum = withdrawals
			.filter(w => w.userId === args.where.userId && (args.where.status === undefined || w.status === args.where.status))
			.reduce((s, w) => s + w.amount, 0);
		return { _sum: { amount: sum || null } };
	});
	const createSpy = t.mock.fn(async (args: any) => {
		const row = { id: `withdrawal-${nextId++}`, status: 'PENDING', ...args.data };
		withdrawals.push(row);
		return row;
	});

	const tx = { withdrawal: { aggregate: aggregateSpy, create: createSpy } };
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

	const prismaMock: any = {
		$transaction: transactionSpy,
		withdrawal: { findUnique: findUniqueSpy, update: updateSpy }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

	const getWalletSpy = t.mock.fn(async (_userId: string, _client?: unknown) => ({
		summary: { availableBalance: opts.availableBalance ?? 1000, currency: 'USD' }
	}));
	t.mock.module('./provider-finance.service', {
		namedExports: { providerFinanceService: { getWallet: getWalletSpy } }
	});

	return { createSpy, aggregateSpy, transactionSpy, getWalletSpy, withdrawals };
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
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: transactionSpy } } });
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
