import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Release-blocker fix: admin approval of a marketer/affiliate commission
// withdrawal must be validated against the affiliate's APPROVED
// CommissionLog balance — never against the provider wallet
// (providerFinanceService.getWallet), which is 0 for a marketer who is not a
// provider and made every legitimate commission withdrawal un-approvable.

type Owner = { accountType: string; roles: string[]; activeRole: string; affiliateProfile: { id: string } | null };

const MARKETER: Owner = { accountType: 'MARKETING_BROKER', roles: ['CLIENT', 'AFFILIATE'], activeRole: 'AFFILIATE', affiliateProfile: { id: 'aff-1' } };
const PROVIDER: Owner = { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null };
const PROVIDER_AND_AFFILIATE: Owner = { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'AFFILIATE'], activeRole: 'PROVIDER', affiliateProfile: { id: 'aff-2' } };

function statusMatches(rowStatus: string, whereStatus: any): boolean {
	if (whereStatus === undefined) return true;
	if (whereStatus && typeof whereStatus === 'object' && 'in' in whereStatus) return whereStatus.in.includes(rowStatus);
	return rowStatus === whereStatus;
}

function createMock(t: TestContext, opts: {
	owner: Owner | null;
	commissions?: { affiliateId: string; amount: number; status: string }[];
	withdrawals?: any[];
	providerWalletBalance?: number;
	affiliateProfile?: any;
	// Throws a P2034 at commit for the given attempts; `onConflict` runs just
	// before throwing, after the doomed attempt's writes were rolled back.
	conflict?: { attempts: number; onConflict?: (withdrawals: any[]) => void };
}) {
	const withdrawals: any[] = (opts.withdrawals ?? []).map(w => ({ currency: 'SAR', method: 'bank_transfer', ...w }));
	const commissions = opts.commissions ?? [];
	const walletTransactions: any[] = [];
	let attempt = 0;

	const commissionAggregateSpy = t.mock.fn(async (args: any) => {
		const sum = commissions
			.filter(c => c.affiliateId === args.where.affiliateId && statusMatches(c.status, args.where.status))
			.reduce((s, c) => s + c.amount, 0);
		return { _sum: { amount: sum || null } };
	});
	const withdrawalAggregateSpy = t.mock.fn(async (args: any) => {
		const sum = withdrawals
			.filter(w => w.userId === args.where.userId && statusMatches(w.status, args.where.status))
			.reduce((s, w) => s + w.amount, 0);
		return { _sum: { amount: sum || null } };
	});
	const createSpy = t.mock.fn(async (args: any) => {
		const row = { status: 'PENDING', ...args.data };
		withdrawals.push(row);
		return row;
	});
	const updateManySpy = t.mock.fn(async (args: any) => {
		const target = withdrawals.find(w => w.id === args.where.id);
		if (!target || target.status !== args.where.status) return { count: 0 };
		Object.assign(target, args.data);
		return { count: 1 };
	});
	const findUniqueOrThrowSpy = t.mock.fn(async (args: any) => ({ ...withdrawals.find(w => w.id === args.where.id) }));
	const walletTransactionCreateSpy = t.mock.fn(async (args: any) => {
		if (walletTransactions.some(wt => wt.referenceId && wt.referenceId === args.data.referenceId)) {
			throw new Error('unique constraint (test mock): WalletTransaction.referenceId');
		}
		const wt = { id: `wt-${walletTransactions.length + 1}`, ...args.data };
		walletTransactions.push(wt);
		return wt;
	});

	const tx = {
		commissionLog: { aggregate: commissionAggregateSpy },
		withdrawal: { aggregate: withdrawalAggregateSpy, create: createSpy, updateMany: updateManySpy, findUniqueOrThrow: findUniqueOrThrowSpy },
		walletTransaction: { create: walletTransactionCreateSpy }
	};
	// A mock cannot reproduce Postgres SSI conflict detection; it models the
	// guarantee SERIALIZABLE gives instead — concurrent transactions behave as
	// if executed in SOME serial order — by running transaction bodies one at
	// a time. (Commit-time conflicts + retry are modeled separately by
	// `opts.conflict`.)
	let queue: Promise<unknown> = Promise.resolve();
	const transactionSpy = t.mock.fn((fn: any) => {
		const run = queue.then(() => runTransaction(fn));
		queue = run.catch(() => undefined);
		return run;
	});
	const runTransaction = async (fn: any) => {
		attempt += 1;
		const snapshot = withdrawals.map(w => ({ ...w }));
		const count = withdrawals.length;
		const wtSnapshot = [...walletTransactions];
		const restore = () => {
			withdrawals.length = count;
			withdrawals.forEach((w, i) => Object.assign(w, snapshot[i]));
			walletTransactions.length = 0; walletTransactions.push(...wtSnapshot);
		};
		let result: unknown;
		try { result = await fn(tx); } catch (e) { restore(); throw e; }
		if (opts.conflict && attempt <= opts.conflict.attempts) {
			restore();
			opts.conflict.onConflict?.(withdrawals);
			const { Prisma } = await import('@prisma/client');
			throw new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' });
		}
		return result;
	};

	const prismaMock: any = {
		$transaction: transactionSpy,
		withdrawal: { findUnique: t.mock.fn(async (args: any) => { const w = withdrawals.find(x => x.id === args.where.id); return w ? { ...w } : null; }) },
		user: { findUnique: t.mock.fn(async () => opts.owner) },
		affiliateProfile: {
			findUnique: t.mock.fn(async () => opts.affiliateProfile === undefined
				? { id: 'aff-1', iban: 'SA4420000001234567891234', bankName: 'Bank', accountHolderName: 'Marketer', minimumPayoutAmount: 50 }
				: opts.affiliateProfile)
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

	const getWalletSpy = t.mock.fn(async () => ({ summary: { availableBalance: opts.providerWalletBalance ?? 0, currency: 'USD' } }));
	t.mock.module('./provider-finance.service', { namedExports: { providerFinanceService: { getWallet: getWalletSpy } } });

	return { withdrawals, walletTransactions, commissionAggregateSpy, withdrawalAggregateSpy, getWalletSpy, transactionSpy, createSpy };
}

async function load(t: TestContext, opts: Parameters<typeof createMock>[1]) {
	const mocks = createMock(t, opts);
	const { withdrawalService } = await import(`./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { withdrawalService, ...mocks };
}

const pending = (id: string, amount: number, userId = 'marketer-1') => ({ id, userId, amount, status: 'PENDING', referenceId: `withdrawal-${id}` });

test('1. approve: a marketer (not a provider) withdrawal within APPROVED commissions is approved — checked against CommissionLog, never the provider wallet', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions, getWalletSpy, commissionAggregateSpy, transactionSpy } = await load(t, {
		owner: MARKETER,
		providerWalletBalance: 0,
		commissions: [{ affiliateId: 'aff-1', amount: 300, status: 'APPROVED' }, { affiliateId: 'aff-1', amount: 200, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 400)]
	});

	const result = await withdrawalService.approve('wd-1', 'admin-1', { adminNote: 'ok' });

	assert.equal(result.status, 'APPROVED');
	assert.equal(result.reviewedById, 'admin-1');
	assert.equal(getWalletSpy.mock.callCount(), 0, 'provider wallet must never be consulted for a marketer withdrawal');
	assert.equal(commissionAggregateSpy.mock.callCount(), 1);
	assert.deepEqual(commissionAggregateSpy.mock.calls[0].arguments[0].where, { affiliateId: 'aff-1', status: 'APPROVED' });
	assert.equal(transactionSpy.mock.calls[0].arguments[1]?.isolationLevel, 'Serializable');
	assert.equal(walletTransactions.length, 1);
	assert.equal(walletTransactions[0].amount, -400);
	assert.equal(walletTransactions[0].currency, 'SAR', 'the debit record keeps the withdrawal\'s own stored currency');
	assert.equal(walletTransactions[0].referenceId, 'withdrawal-wd-1');
	assert.equal(withdrawals[0].status, 'APPROVED');
});

test('2. approve: insufficient marketer commission is rejected cleanly (400) — nothing transitions, no debit written', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions, getWalletSpy } = await load(t, {
		owner: MARKETER,
		providerWalletBalance: 1_000_000, // a large provider balance must NOT make this pass
		commissions: [
			{ affiliateId: 'aff-1', amount: 100, status: 'APPROVED' },
			{ affiliateId: 'aff-1', amount: 900, status: 'PENDING' }, // not yet approved -> not withdrawable
			{ affiliateId: 'aff-1', amount: 900, status: 'PAID' },
			{ affiliateId: 'other-aff', amount: 900, status: 'APPROVED' } // another affiliate's commissions
		],
		withdrawals: [pending('wd-1', 200)]
	});

	await assert.rejects(withdrawalService.approve('wd-1', 'admin-1', {}), (e: any) => e.statusCode === 400 && /عمولات/.test(e.message));
	assert.equal(withdrawals[0].status, 'PENDING');
	assert.equal(walletTransactions.length, 0);
	assert.equal(getWalletSpy.mock.callCount(), 0);
});

test('2b. approve: already APPROVED/COMPLETED/PROCESSING/REVERSED marketer withdrawals consume commission; PENDING and REJECTED do not', async (t) => {
	const base = [{ affiliateId: 'aff-1', amount: 500, status: 'APPROVED' }];
	// consumed: 100 + 100 + 100 + 100 = 400 -> remaining 100
	const consumed = [
		{ id: 'a', userId: 'marketer-1', amount: 100, status: 'APPROVED' },
		{ id: 'b', userId: 'marketer-1', amount: 100, status: 'COMPLETED' },
		{ id: 'c', userId: 'marketer-1', amount: 100, status: 'PROCESSING' },
		{ id: 'd', userId: 'marketer-1', amount: 100, status: 'REVERSED' },
		{ id: 'e', userId: 'marketer-1', amount: 300, status: 'REJECTED' },
		{ id: 'f', userId: 'marketer-1', amount: 300, status: 'PENDING' }
	];
	await t.test('150 over remaining 100 -> rejected', async (t2) => {
		const over = await load(t2, { owner: MARKETER, commissions: base, withdrawals: [pending('wd-1', 150), ...consumed] });
		await assert.rejects(over.withdrawalService.approve('wd-1', 'admin-1', {}), (e: any) => e.statusCode === 400);
		assert.equal(over.withdrawals[0].status, 'PENDING');
	});
	await t.test('exactly remaining 100 -> approved (inclusive boundary)', async (t2) => {
		const exact = await load(t2, { owner: MARKETER, commissions: base, withdrawals: [pending('wd-1', 100), ...consumed] });
		const ok = await exact.withdrawalService.approve('wd-1', 'admin-1', {});
		assert.equal(ok.status, 'APPROVED');
	});
});

test('3. approve: a marketer who is NOT a provider (provider wallet 0, no ProviderProfile) can have a legitimate withdrawal approved', async (t) => {
	const { withdrawalService, getWalletSpy } = await load(t, {
		owner: { ...MARKETER, accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT', 'AFFILIATE'] }, // role-equivalence marketer
		providerWalletBalance: 0,
		commissions: [{ affiliateId: 'aff-1', amount: 250, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 250)]
	});
	const result = await withdrawalService.approve('wd-1', 'admin-1', {});
	assert.equal(result.status, 'APPROVED');
	assert.equal(getWalletSpy.mock.callCount(), 0);
});

test('4. approve: repeated approval of the same marketer withdrawal never double-consumes — second call is a clean 409, exactly one debit', async (t) => {
	const { withdrawalService, walletTransactions, transactionSpy } = await load(t, {
		owner: MARKETER,
		commissions: [{ affiliateId: 'aff-1', amount: 1000, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 200)]
	});
	await withdrawalService.approve('wd-1', 'admin-1', {});
	await assert.rejects(withdrawalService.approve('wd-1', 'admin-2', {}), (e: any) => e.statusCode === 409);
	assert.equal(walletTransactions.length, 1);
	assert.equal(transactionSpy.mock.callCount(), 1, 'the repeated call is refused before any transaction');
});

test('4b. approve: a concurrent duplicate that passed the outer PENDING check loses at the conditional transition — 409, no second debit', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions } = await load(t, {
		owner: MARKETER,
		commissions: [{ affiliateId: 'aff-1', amount: 1000, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 200)]
	});
	// Both callers read PENDING; run them concurrently.
	const results = await Promise.allSettled([
		withdrawalService.approve('wd-1', 'admin-1', {}),
		withdrawalService.approve('wd-1', 'admin-2', {})
	]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
	assert.equal(rejected.reason.statusCode, 409);
	assert.equal(walletTransactions.length, 1);
	assert.equal(withdrawals[0].status, 'APPROVED');
});

test('4c. reject: a rejected marketer withdrawal does not consume commission — a later withdrawal of the full balance is approvable', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions } = await load(t, {
		owner: MARKETER,
		commissions: [{ affiliateId: 'aff-1', amount: 300, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 300), pending('wd-2', 300)]
	});
	await withdrawalService.reject('wd-1', 'admin-1', { rejectionReason: 'bad iban' });
	const ok = await withdrawalService.approve('wd-2', 'admin-1', {});
	assert.equal(ok.status, 'APPROVED');
	assert.equal(withdrawals[0].status, 'REJECTED');
	assert.equal(walletTransactions.length, 1);
	assert.equal(walletTransactions[0].referenceId, 'withdrawal-wd-2');
});

test('5. regression: a provider withdrawal is still checked against the provider wallet, and CommissionLog is never read', async (t) => {
	await t.test('sufficient provider wallet -> approved', async (t2) => {
		const ok = await load(t2, { owner: PROVIDER, providerWalletBalance: 500, withdrawals: [pending('wd-1', 300, 'provider-1')] });
		const result = await ok.withdrawalService.approve('wd-1', 'admin-1', {});
		assert.equal(result.status, 'APPROVED');
		assert.equal(ok.getWalletSpy.mock.callCount(), 1);
		assert.equal(ok.getWalletSpy.mock.calls[0].arguments[0], 'provider-1');
		assert.equal(ok.commissionAggregateSpy.mock.callCount(), 0);
	});
	await t.test('insufficient provider wallet -> rejected with the unchanged provider error', async (t2) => {
		const low = await load(t2, {
			owner: PROVIDER,
			providerWalletBalance: 100,
			commissions: [{ affiliateId: 'aff-1', amount: 1_000_000, status: 'APPROVED' }],
			withdrawals: [pending('wd-1', 300, 'provider-1')]
		});
		await assert.rejects(low.withdrawalService.approve('wd-1', 'admin-1', {}), (e: any) => e.statusCode === 400 && /المزود/.test(e.message));
		assert.equal(low.commissionAggregateSpy.mock.callCount(), 0);
	});
});

test('5b. regression: a provider who also holds the AFFILIATE role keeps the unchanged provider-wallet approval path', async (t) => {
	const { withdrawalService, getWalletSpy, commissionAggregateSpy } = await load(t, {
		owner: PROVIDER_AND_AFFILIATE, providerWalletBalance: 500, withdrawals: [pending('wd-1', 300, 'provider-1')]
	});
	const result = await withdrawalService.approve('wd-1', 'admin-1', {});
	assert.equal(result.status, 'APPROVED');
	assert.equal(getWalletSpy.mock.callCount(), 1);
	assert.equal(commissionAggregateSpy.mock.callCount(), 0);
});

test('6. concurrency: two different PENDING marketer withdrawals whose sum exceeds commissions — at most one is approved, total approved never exceeds the commission balance', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions } = await load(t, {
		owner: MARKETER,
		commissions: [{ affiliateId: 'aff-1', amount: 500, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 300), pending('wd-2', 300)]
	});
	const results = await Promise.allSettled([
		withdrawalService.approve('wd-1', 'admin-1', {}),
		withdrawalService.approve('wd-2', 'admin-2', {})
	]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const approvedTotal = withdrawals.filter(w => w.status === 'APPROVED').reduce((s, w) => s + w.amount, 0);
	assert.ok(approvedTotal <= 500);
	assert.equal(walletTransactions.length, 1);
});

test('6b. concurrency: a SERIALIZABLE conflict is retried and the retry re-reads the competing approval — overspend is refused with the clean business error', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions, commissionAggregateSpy, transactionSpy } = await load(t, {
		owner: MARKETER,
		commissions: [{ affiliateId: 'aff-1', amount: 500, status: 'APPROVED' }],
		withdrawals: [pending('wd-1', 300), pending('wd-2', 300)],
		// First attempt conflicts because a competing approval of wd-2 committed.
		conflict: { attempts: 1, onConflict: ws => { ws.find(w => w.id === 'wd-2').status = 'APPROVED'; } }
	});
	await assert.rejects(withdrawalService.approve('wd-1', 'admin-1', {}), (e: any) => e.statusCode === 400 && /عمولات/.test(e.message));
	assert.equal(transactionSpy.mock.callCount(), 2);
	assert.equal(commissionAggregateSpy.mock.callCount(), 2, 'balance re-read fresh on retry');
	assert.equal(withdrawals.find(w => w.id === 'wd-1').status, 'PENDING');
	assert.equal(walletTransactions.length, 0);
});

test('7. createForMarketer: a user who is both provider and affiliate is refused (409) — no commission withdrawal can be created that approve() would check against the provider wallet', async (t) => {
	const { withdrawalService, createSpy, transactionSpy } = await load(t, {
		owner: PROVIDER_AND_AFFILIATE,
		commissions: [{ affiliateId: 'aff-1', amount: 500, status: 'APPROVED' }]
	});
	await assert.rejects(withdrawalService.createForMarketer('marketer-1', { amount: 100 }), (e: any) => e.statusCode === 409);
	assert.equal(createSpy.mock.callCount(), 0);
	assert.equal(transactionSpy.mock.callCount(), 0);
});

test('8. end-to-end: createForMarketer -> approve for a marketer who is not a provider; a second request beyond the remaining commission cannot be created', async (t) => {
	const { withdrawalService, withdrawals, walletTransactions, getWalletSpy } = await load(t, {
		owner: MARKETER,
		providerWalletBalance: 0,
		commissions: [{ affiliateId: 'aff-1', amount: 500, status: 'APPROVED' }]
	});
	const created = await withdrawalService.createForMarketer('marketer-1', { amount: 400 });
	assert.equal(created.currency, 'SAR');
	assert.equal(created.method, 'bank_transfer');
	const approved = await withdrawalService.approve(created.id, 'admin-1', {});
	assert.equal(approved.status, 'APPROVED');
	assert.equal(getWalletSpy.mock.callCount(), 0);
	assert.equal(walletTransactions.length, 1);
	await assert.rejects(withdrawalService.createForMarketer('marketer-1', { amount: 200 }), (e: any) => e.statusCode === 400);
	assert.equal(withdrawals.length, 1);
});
