import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// paypal-finance.service.ts pulls in client-finance.service.ts (for the
// shared getWallet() call at the end of a successful capture), which eagerly
// does `new OpenAI({...})` in its constructor chain — same established
// pattern as provider-profile.service.test.ts / client-requests.service.test.ts
// for the same reason.
process.env.OPENAI_API_KEY = 'test-key';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
process.env.PAYPAL_ENV = 'sandbox';

function findPayment(payments: any[], where: any) {
	return payments.find(
		p =>
			(where.id === undefined || p.id === where.id) &&
			(where.paypalOrderId === undefined || p.paypalOrderId === where.paypalOrderId) &&
			(where.status === undefined || p.status === where.status)
	);
}

function createPrismaMock(t: TestContext, opts: { seedPayments?: any[]; seedWalletTxRefs?: string[] } = {}) {
	const payments: any[] = (opts.seedPayments || []).map((p, i) => ({ id: p.id || `pp-${i + 1}`, ...p }));
	const walletTxRefs = new Set<string>(opts.seedWalletTxRefs || []);

	const walletTransactionCreateSpy = t.mock.fn((args: any) => {
		walletTxRefs.add(args.data.referenceId);
		return { id: `wt-${walletTxRefs.size}`, ...args.data };
	});
	const userUpdateSpy = t.mock.fn((args: any) => ({ id: args.where.id, ...args.data }));
	const accountAuditLogCreateSpy = t.mock.fn(() => ({}));
	const notificationCreateSpy = t.mock.fn(() => ({}));
	const createPaypalPaymentSpy = t.mock.fn((args: any) => {
		const row = { id: `pp-${payments.length + 1}`, ...args.data };
		payments.push(row);
		return row;
	});

	const txStub = {
		walletTransaction: { create: walletTransactionCreateSpy },
		user: { update: userUpdateSpy },
		paypalPayment: {
			update: async (args: any) => {
				const row = findPayment(payments, args.where);
				if (row) Object.assign(row, args.data);
				return row;
			}
		},
		accountAuditLog: { create: accountAuditLogCreateSpy },
		notification: { create: notificationCreateSpy }
	};

	const prismaMock: any = {
		paypalPayment: {
			create: createPaypalPaymentSpy,
			findUnique: async (args: any) => findPayment(payments, args.where) ?? null,
			updateMany: async (args: any) => {
				const matches = payments.filter(
					p =>
						(args.where.id === undefined || p.id === args.where.id) &&
						(args.where.paypalOrderId === undefined || p.paypalOrderId === args.where.paypalOrderId) &&
						(args.where.status === undefined || p.status === args.where.status)
				);
				matches.forEach(p => Object.assign(p, args.data));
				return { count: matches.length };
			}
		},
		walletTransaction: {
			findFirst: async (args: any) => (walletTxRefs.has(args.where.referenceId) ? { referenceId: args.where.referenceId } : null),
			create: walletTransactionCreateSpy,
			findMany: async () => []
		},
		user: {
			update: userUpdateSpy,
			findUnique: async (args: any) => ({ id: args.where.id, firstName: 'Test', lastName: 'User', walletBalance: 0 })
		},
		project: { findMany: async () => [] },
		accountAuditLog: { create: accountAuditLogCreateSpy },
		notification: { create: notificationCreateSpy },
		$transaction: async (fn: any) => fn(txStub)
	};

	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return { payments, walletTxRefs, createPaypalPaymentSpy, walletTransactionCreateSpy, userUpdateSpy };
}

function mockPaypalService(t: TestContext, impl: { createOrder?: any; captureOrder?: any; verifyWebhookSignature?: any } = {}) {
	t.mock.module('./paypal.service', {
		namedExports: {
			paypalService: {
				createOrder: impl.createOrder || (async () => ({ id: 'ORDER-1' })),
				captureOrder:
					impl.captureOrder ||
					(async () => ({
						purchase_units: [
							{
								custom_id: 'client-1',
								payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '50.00' } }] }
							}
						]
					})),
				verifyWebhookSignature: impl.verifyWebhookSignature || (async () => true)
			}
		}
	});
}

async function loadService(t: TestContext) {
	const moduleUrl = `./paypal-finance.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { paypalFinanceService } = await import(moduleUrl);
	return paypalFinanceService;
}

test('initiateDeposit: an out-of-range amount is rejected before PayPal is ever contacted', async (t) => {
	const { createPaypalPaymentSpy } = createPrismaMock(t);
	let createOrderCalled = false;
	mockPaypalService(t, { createOrder: async () => { createOrderCalled = true; return { id: 'ORDER-X' }; } });

	const service = await loadService(t);
	await assert.rejects(() => service.initiateDeposit('client-1', 10), /50/);
	assert.equal(createOrderCalled, false);
	assert.equal(createPaypalPaymentSpy.mock.callCount(), 0);
});

test('initiateDeposit: a PayPal order-create failure never creates a payment record', async (t) => {
	const { createPaypalPaymentSpy } = createPrismaMock(t);
	mockPaypalService(t, {
		createOrder: async () => {
			throw new Error('PayPal is down');
		}
	});

	const service = await loadService(t);
	await assert.rejects(() => service.initiateDeposit('client-1', 100));
	assert.equal(createPaypalPaymentSpy.mock.callCount(), 0);
});

test('initiateDeposit: missing PayPal configuration fails safely instead of silently succeeding', async (t) => {
	const { createPaypalPaymentSpy } = createPrismaMock(t);
	mockPaypalService(t, {
		createOrder: async () => {
			throw new Error('بوابة PayPal غير مهيأة: PAYPAL_CLIENT_ID أو PAYPAL_CLIENT_SECRET غير معرّف');
		}
	});

	const service = await loadService(t);
	await assert.rejects(() => service.initiateDeposit('client-1', 100), /غير مهيأة/);
	assert.equal(createPaypalPaymentSpy.mock.callCount(), 0);
});

test('initiateDeposit: on success, persists a PENDING payment row referencing the real PayPal order id', async (t) => {
	const { createPaypalPaymentSpy } = createPrismaMock(t);
	mockPaypalService(t, { createOrder: async () => ({ id: 'ORDER-42' }) });

	const service = await loadService(t);
	const result = await service.initiateDeposit('client-1', 75);

	assert.equal(result.paypalOrderId, 'ORDER-42');
	assert.equal(createPaypalPaymentSpy.mock.callCount(), 1);
	const data = createPaypalPaymentSpy.mock.calls[0].arguments[0].data;
	assert.equal(data.paypalOrderId, 'ORDER-42');
	assert.equal(data.userId, 'client-1');
	assert.equal(data.status, 'PENDING');
	assert.equal(data.currency, 'USD');
});

test('captureDeposit: ownership is enforced — a payment belonging to another user is rejected', async (t) => {
	createPrismaMock(t, {
		seedPayments: [{ userId: 'someone-else', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	await assert.rejects(() => service.captureDeposit('client-1', 'ORDER-1'), (err: any) => {
		assert.equal(err.statusCode, 403);
		return true;
	});
});

test('captureDeposit: a currency other than USD is rejected and never credits the wallet', async (t) => {
	const { walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t, {
		captureOrder: async () => ({
			purchase_units: [{ custom_id: 'client-1', payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '50.00' } }] } }]
		})
	});

	const service = await loadService(t);
	await assert.rejects(() => service.captureDeposit('client-1', 'ORDER-1'));
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0);
	assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('captureDeposit: an amount that does not exactly match the recorded amount is rejected and never credits the wallet', async (t) => {
	const { walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t, {
		captureOrder: async () => ({
			purchase_units: [{ custom_id: 'client-1', payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '50.01' } }] } }]
		})
	});

	const service = await loadService(t);
	await assert.rejects(() => service.captureDeposit('client-1', 'ORDER-1'));
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0);
	assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('captureDeposit: a DECLINED/incomplete capture is marked FAILED and never credits the wallet', async (t) => {
	const { payments, walletTransactionCreateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t, {
		captureOrder: async () => ({
			purchase_units: [{ custom_id: 'client-1', payments: { captures: [{ id: 'CAPTURE-1', status: 'DECLINED', amount: { currency_code: 'USD', value: '50.00' } }] } }]
		})
	});

	const service = await loadService(t);
	await assert.rejects(() => service.captureDeposit('client-1', 'ORDER-1'));
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0);
	assert.equal(payments[0].status, 'FAILED');
});

test('captureDeposit: a successful capture credits the wallet exactly once', async (t) => {
	const { payments, walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	await service.captureDeposit('client-1', 'ORDER-1');

	assert.equal(walletTransactionCreateSpy.mock.callCount(), 1);
	assert.equal(walletTransactionCreateSpy.mock.calls[0].arguments[0].data.referenceId, 'CAPTURE-1');
	assert.equal(walletTransactionCreateSpy.mock.calls[0].arguments[0].data.amount, 50);
	assert.equal(walletTransactionCreateSpy.mock.calls[0].arguments[0].data.currency, 'USD');
	assert.equal(userUpdateSpy.mock.callCount(), 1);
	assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.walletBalance.increment, 50);
	assert.equal(payments[0].status, 'COMPLETED');
});

test('captureDeposit: the resulting WalletTransaction explicitly sets currency USD — never relies on the schema default (which is SAR)', async (t) => {
	const { walletTransactionCreateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	await service.captureDeposit('client-1', 'ORDER-1');

	const data = walletTransactionCreateSpy.mock.calls[0].arguments[0].data;
	assert.equal('currency' in data, true, 'currency must be explicitly present in the create() call, not left to the Prisma schema default');
	assert.equal(data.currency, 'USD');
});

test('captureDeposit: a repeated capture request for an already-completed payment is an idempotent no-op', async (t) => {
	const { walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	await service.captureDeposit('client-1', 'ORDER-1');
	await service.captureDeposit('client-1', 'ORDER-1'); // repeat

	assert.equal(walletTransactionCreateSpy.mock.callCount(), 1);
	assert.equal(userUpdateSpy.mock.callCount(), 1);
});

test('completeFromWebhook: a duplicate COMPLETED webhook after the capture endpoint already credited the wallet is a no-op', async (t) => {
	const { walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	await service.captureDeposit('client-1', 'ORDER-1');
	const result = await service.completeFromWebhook({ paypalOrderId: 'ORDER-1', paypalCaptureId: 'CAPTURE-1', currency: 'USD', amountValue: '50.00' });

	assert.equal(result.alreadyCompleted, true);
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 1); // still just the one from captureDeposit
	assert.equal(userUpdateSpy.mock.callCount(), 1);
});

test('completeFromWebhook: can finalize a still-PENDING payment on its own (browser disappeared before the capture call landed)', async (t) => {
	const { payments, walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	const result = await service.completeFromWebhook({ paypalOrderId: 'ORDER-1', paypalCaptureId: 'CAPTURE-1', currency: 'USD', amountValue: '50.00' });

	assert.equal(result.handled, true);
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 1);
	assert.equal(userUpdateSpy.mock.callCount(), 1);
	assert.equal(payments[0].status, 'COMPLETED');
});

test('denyFromWebhook: marks the pending payment FAILED and never touches the wallet', async (t) => {
	const { payments, walletTransactionCreateSpy, userUpdateSpy } = createPrismaMock(t, {
		seedPayments: [{ userId: 'client-1', paypalOrderId: 'ORDER-1', amount: '50.00', currency: 'USD', status: 'PENDING' }]
	});
	mockPaypalService(t);

	const service = await loadService(t);
	await service.denyFromWebhook('ORDER-1');

	assert.equal(payments[0].status, 'FAILED');
	assert.equal(walletTransactionCreateSpy.mock.callCount(), 0);
	assert.equal(userUpdateSpy.mock.callCount(), 0);
});
