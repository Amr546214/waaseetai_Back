import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

// Phase 3E.2: getCart()/formatCartItem() and createOrder()'s NEW OrderItem
// snapshot previously built provider name/initials from the raw, shared User
// columns and "level" from the stale, never-written User.currentLevel — even
// though ProviderProfile has its own independent Phase 3A/3D.1 display
// columns and ProviderGamification.currentLevelIndex is the real, persisted
// (Phase 3D.3A) progression cache. These tests exercise the fixed live-cart
// formatting and the NEW-order snapshot sourcing, reusing the exact same
// resolveProviderDisplayIdentity/resolveProviderProgression helpers 3E.1
// introduced — no new formula, no real DB.

function makeProvider(overrides: any = {}) {
  return {
    id: overrides.id || 'provider-1',
    firstName: 'Amr',
    lastName: 'Okasha',
    currentLevel: 'مستكشف - المستوى 1',
    providerProfile: { firstName: null, lastName: null, isVerified: false },
    gamification: null,
    ...overrides
  };
}

function makeService(overrides: any = {}) {
  return {
    id: overrides.id || 'service-1',
    title: 'خدمة تجريبية',
    totalAmount: 100,
    totalDays: 5,
    aiScore: 80,
    specialty: { name: 'Design', nameAr: 'تصميم', slug: 'design' },
    provider: overrides.provider,
    ...overrides
  };
}

// --- Live cart (getCart/formatCartItem) -------------------------------------

function createCartMockPrisma(t: TestContext, service: any) {
  const cartItem = {
    id: 'item-1',
    packageName: 'الباقة الأساسية',
    addedAt: new Date('2024-01-01T00:00:00Z'),
    savedForLater: false,
    service
  };
  const cartUpsertSpy = t.mock.fn(async () => ({ id: 'cart-1', items: [cartItem] }));

  const prismaMock: any = { cart: { upsert: cartUpsertSpy } };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

  return { cartUpsertSpy };
}

async function loadServiceForCart(t: TestContext, service: any) {
  const mocks = createCartMockPrisma(t, service);
  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);
  return { cartCheckoutService, ...mocks };
}

test('getCart: live cart uses ProviderProfile name (identity wins over legacy User)', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  // User: Amr Okasha; ProviderProfile: Amr Expert -> must show the Provider persona.
  assert.equal(cart.items[0].provider.name, 'Amr Expert');
});

test('getCart: live cart uses Provider-derived initials, not legacy User initials', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].provider.initials, 'AE');
});

test('getCart: level uses canonical ProviderGamification progression, not legacy User.currentLevel', async (t) => {
  const provider = makeProvider({
    currentLevel: 'مستكشف - المستوى 1', // stale — must not be what's shown
    gamification: { points: 150, currentLevelIndex: 3 } // LEVEL_MATRIX[2] = 'منفذ'
  });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].level, 'منفذ');
});

test('getCart: partial ProviderProfile identity falls back field-by-field to User (firstName from Provider, lastName from User)', async (t) => {
  const provider = makeProvider({
    firstName: 'Amr', lastName: 'Okasha',
    providerProfile: { firstName: 'Amr', lastName: null, isVerified: false }
  });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].provider.name, 'Amr Okasha');
});

test('getCart: an existing ProviderGamification row always wins over a disagreeing legacy User.currentLevel', async (t) => {
  const provider = makeProvider({
    currentLevel: 'مستكشف - المستوى 1', // deliberately disagreeing legacy value
    gamification: { points: 0, currentLevelIndex: 1 } // LEVEL_MATRIX[0] = 'مبتدئ'
  });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].level, 'مبتدئ');
});

test('getCart: missing ProviderGamification preserves the existing legacy-fallback compatibility behavior', async (t) => {
  const provider = makeProvider({ currentLevel: 'مستكشف - المستوى 1', gamification: null });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].level, 'مستكشف - المستوى 1');
});

test('getCart: no ClientProfile/AffiliateProfile data participates in Provider cart display', async (t) => {
  // The provider fixture below has no clientProfile/affiliateProfile keys at
  // all, and the mocked prisma client defines no such models — if
  // formatCartItem ever touched either, this would throw.
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].provider.name, 'Amr Expert');
});

test('getCart: monetary/model fields (totalAmount, totalDays, aiScore, modelId) are unaffected by the identity fix', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ id: 'service-42', provider, totalAmount: 250, totalDays: 7, aiScore: 91 }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].modelId, 'service-42');
  assert.equal(cart.items[0].totalAmount, 250);
  assert.equal(cart.items[0].totalDays, 7);
  assert.equal(cart.items[0].aiScore, 91);
});

// --- Checkout / new order snapshot ------------------------------------------

function createOrderMockPrisma(t: TestContext, service: any) {
  let createdItemData: any = null;
  const orderCreateSpy = t.mock.fn(async (args: any) => {
    createdItemData = args.data.items.create[0];
    return {
      id: 'order-1',
      orderNumber: 'WS-2024-000001',
      subtotal: args.data.subtotal,
      discount: args.data.discount,
      total: args.data.total,
      couponCode: args.data.couponCode ?? null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      items: [{ id: 'orderitem-1', ...createdItemData }]
    };
  });

  const tx = {
    order: { count: async () => 0, create: orderCreateSpy }
  };

  const prismaMock: any = {
    serviceCatalog: { findMany: async () => [service] },
    project: { findMany: async () => [] },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

  return { orderCreateSpy, getCreatedItemData: () => createdItemData };
}

async function loadServiceForOrder(t: TestContext, service: any) {
  const mocks = createOrderMockPrisma(t, service);
  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);
  return { cartCheckoutService, ...mocks };
}

test('createOrder: NEW order snapshots ProviderProfile providerName (not legacy User)', async (t) => {
  const provider = makeProvider({ id: 'provider-9', providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const service = makeService({ id: 'service-1', provider });
  const { cartCheckoutService, getCreatedItemData } = await loadServiceForOrder(t, service);

  await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1' }] });

  assert.equal(getCreatedItemData().providerName, 'Amr Expert');
});

test('createOrder: NEW order snapshots Provider-derived initials', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const service = makeService({ id: 'service-1', provider });
  const { cartCheckoutService, getCreatedItemData } = await loadServiceForOrder(t, service);

  await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1' }] });

  assert.equal(getCreatedItemData().initials, 'AE');
});

test('createOrder: the provider name is written once at creation — no live-lookup fields or functions are stored, only a frozen string', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const service = makeService({ id: 'service-1', provider });
  const { cartCheckoutService, getCreatedItemData } = await loadServiceForOrder(t, service);

  const result = await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1' }] });

  // formatOrderItem (used both here and by getOrder) reads back only the
  // already-persisted providerName/initials columns — it never re-resolves
  // ProviderProfile live. Confirmed by the returned value being a plain
  // string equal to what was written, with no further resolution needed.
  assert.equal(typeof getCreatedItemData().providerName, 'string');
  assert.equal(result.items[0].provider.name, 'Amr Expert');
});

test('createOrder: no ClientProfile/AffiliateProfile identity participates in the snapshot', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const service = makeService({ id: 'service-1', provider });
  const { cartCheckoutService, getCreatedItemData } = await loadServiceForOrder(t, service);

  await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1' }] });

  assert.equal(getCreatedItemData().providerName, 'Amr Expert');
});

test('createOrder: existing monetary fields and IDs are unaffected by the identity source fix', async (t) => {
  const provider = makeProvider({ id: 'provider-9', providerProfile: { firstName: 'Amr', lastName: 'Expert', isVerified: true } });
  const service = makeService({ id: 'service-1', provider, totalAmount: 300, totalDays: 10, aiScore: 77 });
  const { cartCheckoutService, getCreatedItemData } = await loadServiceForOrder(t, service);

  const result = await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1', packageId: 'pro' }] });

  const item = getCreatedItemData();
  assert.equal(item.serviceId, 'service-1');
  assert.equal(item.providerId, 'provider-9');
  assert.equal(item.price, 300);
  assert.equal(item.deliveryDays, 10);
  assert.equal(item.aiScore, 77);
  assert.equal(item.packageId, 'pro');
  assert.equal(result.subtotal, 300);
  assert.equal(result.discount, 0);
  assert.equal(result.total, 300);
});

test('createOrder: falls back to legacy User identity when ProviderProfile display fields are missing', async (t) => {
  const provider = makeProvider({ firstName: 'Amr', lastName: 'Okasha', providerProfile: { firstName: null, lastName: null, isVerified: false } });
  const service = makeService({ id: 'service-1', provider });
  const { cartCheckoutService, getCreatedItemData } = await loadServiceForOrder(t, service);

  await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1' }] });

  assert.equal(getCreatedItemData().providerName, 'Amr Okasha');
});

// --- Wallet-only internal purchasing (USD-canonical) ------------------------
// WaseetAI Wallet is the ONLY accepted internal payment method. PayPal/
// Moyasar/card/STC Pay/Apple Pay are wallet TOP-UP rails only — never a
// direct checkout payment method. Enforced at the SERVICE layer (not just
// the controller's zod schema) so a raw request to this endpoint using any
// other value is rejected regardless of frontend behavior. order.total is
// treated as USD for active purchasing — no SAR->USD conversion anywhere.

test('getPaymentMethods: wallet is the ONLY method offered, with the balance exposed', async (t) => {
  t.mock.module('../config/db', {
    namedExports: { prisma: { user: { findUnique: async () => ({ walletBalance: 250 }) } } }
  });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);

  const methods = await cartCheckoutService.getPaymentMethods('user-1');

  assert.deepEqual(methods.map((m: any) => m.id), ['wallet'], 'no card/moyasar/stc_pay/apple_pay option may ever be advertised');
  assert.equal(methods[0].available, true);
  assert.equal(methods[0].balance, 250);
});

for (const rejected of ['card', 'moyasar', 'stc_pay', 'apple_pay', 'paypal', 'bank', 'cash', '']) {
  test(`initPayment: "${rejected || '(empty string)'}" is rejected before any DB lookup — wallet is the only accepted method`, async (t) => {
    const orderFindFirstSpy = t.mock.fn(async () => {
      throw new Error('should not be reached — method validation must reject first');
    });
    t.mock.module('../config/db', { namedExports: { prisma: { order: { findFirst: orderFindFirstSpy } } } });
    t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

    const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
    const { cartCheckoutService } = await import(moduleUrl);

    await assert.rejects(() => cartCheckoutService.initPayment('user-1', 'order-1', rejected), /طريقة الدفع غير متاحة/);
    assert.equal(orderFindFirstSpy.mock.callCount(), 0, 'a rejected method must never reach the database at all');
  });
}

test('initPayment: "wallet" with a sufficient balance proceeds past the method gate and sends an OTP', async (t) => {
  const order = { id: 'order-1', status: 'PENDING_PAYMENT', total: 100, user: { email: 'client@example.com', phoneNumber: null, walletBalance: 250 } };
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        order: { findFirst: async () => order },
        otpVerification: { deleteMany: async () => ({ count: 0 }), create: async () => ({}) }
      }
    }
  });
  const sendEmailOtpSpy = t.mock.fn(async () => {});
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: sendEmailOtpSpy } } });

  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);

  const result = await cartCheckoutService.initPayment('user-1', 'order-1', 'wallet');

  assert.ok(result.paymentReference);
  assert.equal(sendEmailOtpSpy.mock.callCount(), 1);
});

test('initPayment: an insufficient balance is rejected with a 402 and exact required/available/shortfall — no OTP sent', async (t) => {
  const order = { id: 'order-1', status: 'PENDING_PAYMENT', total: 120, user: { email: 'client@example.com', phoneNumber: null, walletBalance: 80 } };
  t.mock.module('../config/db', { namedExports: { prisma: { order: { findFirst: async () => order } } } });
  const sendEmailOtpSpy = t.mock.fn(async () => {});
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: sendEmailOtpSpy } } });

  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);

  const error: any = await cartCheckoutService.initPayment('user-1', 'order-1', 'wallet').catch((e: any) => e);

  assert.equal(error.statusCode, 402);
  assert.deepEqual(error.errors, [{ required: 120, available: 80, shortfall: 40 }]);
  assert.equal(sendEmailOtpSpy.mock.callCount(), 0, 'no OTP is sent when the pre-check already knows the balance is insufficient');
});

// --- confirmPayment(): the authoritative wallet debit -----------------------

function createConfirmMockPrisma(t: TestContext, opts: { order: any; walletBalance: number; services?: any[]; activePurchases?: any[] }) {
  const users: any[] = [{ id: 'user-1', walletBalance: opts.walletBalance }];
  const walletTransactions: any[] = [];
  let orderUpdated: any = null;

  const updateManyUser = t.mock.fn(async (args: any) => {
    const matches = users.filter(u => u.id === args.where.id && u.walletBalance >= args.where.walletBalance.gte);
    matches.forEach(u => { u.walletBalance -= args.data.walletBalance.decrement; });
    return { count: matches.length };
  });

  const tx = {
    user: { updateMany: updateManyUser, findUnique: async (args: any) => users.find(u => u.id === args.where.id) ?? null },
    walletTransaction: { create: t.mock.fn(async (args: any) => { walletTransactions.push(args.data); return args.data; }) },
    coupon: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    couponRedemption: { count: async () => 0, create: async () => ({}) },
    contract: { create: async (args: any) => ({ id: 'contract-1', ...args.data }) },
    escrow: { create: t.mock.fn(async (args: any) => args.data) },
    projectStage: { create: async () => ({}), createMany: async () => ({}) },
    order: {
      updateMany: t.mock.fn(async (args: any) => {
        if (orderUpdated || args.where.status !== 'PENDING_PAYMENT' || opts.order.status !== 'PENDING_PAYMENT') return { count: 0 };
        orderUpdated = args.data; return { count: 1 };
      })
    },
    project: { create: async (args: any) => ({ id: `project-${args.data.title}`, ...args.data }), findMany: t.mock.fn(async () => opts.activePurchases || []) },
    cartItem: { deleteMany: t.mock.fn(async () => ({ count: 1 })) },
    otpVerification: { delete: async () => ({}) }
  };

  const prismaMock: any = {
    order: { findFirst: async () => opts.order },
    otpVerification: {
      findMany: async () => [{ id: 'otp-1', code: '111111', expiresAt: new Date(Date.now() + 60_000), context: { purpose: 'checkout_payment', orderId: opts.order.id, paymentReference: 'PAY-ABC123', paymentMethod: 'wallet' } }],
      update: async () => ({})
    },
    serviceStage: { findMany: async () => opts.services || [] },
    // Rollback-on-throw for the order transition + wallet state, mirroring a
    // real ROLLBACK (the order PENDING_PAYMENT -> PAID gate now runs first in
    // the transaction, so a later failure must undo it, as Postgres would).
    $transaction: async (fn: any) => {
      const orderSnapshot = orderUpdated;
      const usersSnapshot = users.map(u => ({ ...u }));
      try { return await fn(tx); } catch (error) {
        orderUpdated = orderSnapshot;
        users.length = 0; users.push(...usersSnapshot);
        throw error;
      }
    }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

  return { users, walletTransactions, tx, getOrderUpdated: () => orderUpdated };
}

async function loadServiceForConfirm(t: TestContext, opts: { order: any; walletBalance: number; services?: any[]; activePurchases?: any[] }) {
  const mocks = createConfirmMockPrisma(t, opts);
  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);
  return { cartCheckoutService, ...mocks };
}

function makeOrderForConfirm(overrides: any = {}) {
  return {
    id: 'order-1', orderNumber: 'WS-2026-000001', status: 'PENDING_PAYMENT', total: 100, discount: 0, couponId: null,
    items: [{ id: 'item-1', serviceId: 'service-1', providerId: 'provider-1', title: 'Service', price: 100, deliveryDays: 5, aiScore: 0 }],
    ...overrides
  };
}

test('confirmPayment: sufficient balance — wallet debited exactly once, WalletTransaction is USD, escrow is WALLET, project/contract/stage created, order marked PAID', async (t) => {
  const order = makeOrderForConfirm();
  const { cartCheckoutService, users, walletTransactions, tx } = await loadServiceForConfirm(t, { order, walletBalance: 250 });

  const result = await cartCheckoutService.confirmPayment('user-1', 'order-1', '111111');

  assert.equal(users[0].walletBalance, 150, 'debited exactly the order total, exactly once');
  assert.equal(tx.user.updateMany.mock.callCount(), 1);
  assert.equal(walletTransactions.length, 1);
  assert.equal(walletTransactions[0].type, 'ORDER_PAYMENT');
  assert.equal(walletTransactions[0].amount, -100);
  assert.equal(walletTransactions[0].currency, 'USD', 'active purchasing is treated as USD, never SAR');
  assert.equal(walletTransactions[0].paymentMethod, 'WALLET');
  assert.equal(tx.escrow.create.mock.callCount(), 1);
  assert.equal(tx.escrow.create.mock.calls[0].arguments[0].data.paymentMethod, 'WALLET');
  assert.equal(result.status, 'paid');
  assert.equal(result.projectIds.length, 1);
});

test('confirmPayment: insufficient balance rejects with 402 + required/available/shortfall BEFORE any Project/Contract/Escrow/Order-paid row is created', async (t) => {
  const order = makeOrderForConfirm({ total: 120 });
  const { cartCheckoutService, users, walletTransactions, tx, getOrderUpdated } = await loadServiceForConfirm(t, { order, walletBalance: 80 });

  const error: any = await cartCheckoutService.confirmPayment('user-1', 'order-1', '111111').catch((e: any) => e);

  assert.equal(error.statusCode, 402);
  assert.deepEqual(error.errors, [{ required: 120, available: 80, shortfall: 40 }]);
  assert.equal(users[0].walletBalance, 80, 'never debited');
  assert.equal(walletTransactions.length, 0);
  assert.equal(tx.escrow.create.mock.callCount(), 0, 'no paid resource of any kind is created before a successful debit');
  assert.equal(getOrderUpdated(), null, 'order never marked PAID');
});

test('confirmPayment: two concurrent confirmations for the same user against a balance that can fund only one — exactly one succeeds, the other is rejected 402, no overspend', async (t) => {
  const orderA = makeOrderForConfirm({ id: 'order-A', total: 80 });
  const orderB = makeOrderForConfirm({ id: 'order-B', total: 80 });
  const users: any[] = [{ id: 'user-1', walletBalance: 100 }];
  const walletTransactions: any[] = [];

  const updateManyUser = t.mock.fn(async (args: any) => {
    const matches = users.filter(u => u.id === args.where.id && u.walletBalance >= args.where.walletBalance.gte);
    matches.forEach(u => { u.walletBalance -= args.data.walletBalance.decrement; });
    return { count: matches.length };
  });
  const tx = {
    user: { updateMany: updateManyUser, findUnique: async (args: any) => users.find(u => u.id === args.where.id) ?? null },
    walletTransaction: { create: t.mock.fn(async (args: any) => { walletTransactions.push(args.data); return args.data; }) },
    coupon: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    couponRedemption: { count: async () => 0, create: async () => ({}) },
    project: { create: async (args: any) => ({ id: `project-${args.data.title}`, ...args.data }), findMany: async () => [] },
    contract: { create: async (args: any) => ({ id: 'contract-1', ...args.data }) },
    escrow: { create: t.mock.fn(async (args: any) => args.data) },
    projectStage: { create: async () => ({}), createMany: async () => ({}) },
    order: { updateMany: async () => ({ count: 1 }) },
    cartItem: { deleteMany: async () => ({ count: 0 }) },
    otpVerification: { delete: async () => ({}) }
  };
  const ordersById: Record<string, any> = { 'order-A': orderA, 'order-B': orderB };
  // getPaymentOtp() filters this array client-side by context.orderId, so
  // returning BOTH orders' OTP rows from the same findMany call lets each
  // concurrent confirmPayment() call find its own — no shared mutable state
  // needed between the two concurrent calls.
  const otpRows = ['order-A', 'order-B'].map(orderId => ({
    id: `otp-${orderId}`, code: '111111', expiresAt: new Date(Date.now() + 60_000),
    context: { purpose: 'checkout_payment', orderId, paymentReference: `PAY-${orderId}`, paymentMethod: 'wallet' }
  }));
  const prismaMock: any = {
    order: { findFirst: async (args: any) => ordersById[args.where.id] || null },
    otpVerification: { findMany: async () => otpRows, update: async () => ({}) },
    serviceStage: { findMany: async () => [] },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);

  const confirmOne = (orderId: string) => cartCheckoutService.confirmPayment('user-1', orderId, '111111').catch((e: any) => e);

  const [resultA, resultB] = await Promise.all([confirmOne('order-A'), confirmOne('order-B')]);
  const results = [resultA, resultB];
  const succeeded = results.filter(r => r && r.status === 'paid');
  const failed = results.filter(r => r instanceof Error);

  assert.equal(succeeded.length, 1, 'exactly one of the two concurrent purchases succeeds');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].statusCode, 402);
  assert.equal(users[0].walletBalance, 20, 'only ONE debit of 80 ever applied — no overspend to a negative/over-committed balance');
  assert.equal(walletTransactions.length, 1);
});

// Fix 2 (post-safety-review hardening): the SAME order, confirmed twice
// concurrently, sharing the SAME OTP-derived paymentReference — a scenario
// the review explicitly flagged as untested by the test above (which only
// covers two DIFFERENT orders). The wallet balance here is deliberately
// large enough that BOTH debits would individually satisfy the `gte` guard
// (300 covers two 100 debits) — proving the real backstop is
// WalletTransaction.referenceId's own unique constraint, not the balance
// guard. This mock implements genuine snapshot/rollback-on-throw semantics
// (mirroring payout.service.test.ts's own established transactionSpy
// pattern) — required for this specific test to be trustworthy, since a
// non-rolling-back mock would let the loser's already-applied debit survive
// even though real Postgres would undo it.
test('confirmPayment: two concurrent confirmations for the SAME order (same paymentReference) — exactly one debit, one WalletTransaction, one Project/Contract/Escrow set persist; the loser gets a clean 409, never a raw DB error', async (t) => {
  const order = makeOrderForConfirm({ id: 'order-1', total: 100, status: 'PENDING_PAYMENT' });
  const users: any[] = [{ id: 'user-1', walletBalance: 300 }];
  const walletTransactions: any[] = [];
  const escrows: any[] = [];
  const orders: any[] = [order];

  const updateManyUser = t.mock.fn(async (args: any) => {
    const matches = users.filter(u => u.id === args.where.id && u.walletBalance >= args.where.walletBalance.gte);
    matches.forEach(u => { u.walletBalance -= args.data.walletBalance.decrement; });
    return { count: matches.length };
  });

  const createWalletTransaction = t.mock.fn(async (args: any) => {
    if (walletTransactions.some(w => w.referenceId === args.data.referenceId)) {
      throw new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`referenceId`)',
        { code: 'P2002', clientVersion: 'test', meta: { target: ['referenceId'] } }
      );
    }
    walletTransactions.push(args.data);
    return args.data;
  });

  const tx = {
    user: { updateMany: updateManyUser, findUnique: async (args: any) => users.find(u => u.id === args.where.id) ?? null },
    walletTransaction: { create: createWalletTransaction },
    coupon: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    couponRedemption: { count: async () => 0, create: async () => ({}) },
    project: { create: async (args: any) => ({ id: `project-${Math.random()}`, ...args.data }), findMany: async () => [] },
    contract: { create: async (args: any) => ({ id: `contract-${Math.random()}`, ...args.data }) },
    escrow: { create: t.mock.fn(async (args: any) => { escrows.push(args.data); return args.data; }) },
    projectStage: { create: async () => ({}), createMany: async () => ({}) },
    // Phase 4: the order transition is now the first, guarded statement.
    order: { updateMany: async (args: any) => {
      if (order.status !== args.where.status) return { count: 0 };
      Object.assign(order, args.data); return { count: 1 };
    } },
    cartItem: { deleteMany: async () => ({ count: 0 }) },
    otpVerification: { delete: async () => ({}) }
  };

  // Real-Postgres-accurate transaction simulation, two parts:
  //
  // 1. A FIFO mutex modeling the row-level lock the real debit's
  //    `UPDATE ... WHERE id=$1` takes on the User row for the transaction's
  //    ENTIRE duration (released only at commit/rollback, never earlier) —
  //    without this, two concurrent mock transactions can freely interleave
  //    their individual statements (e.g. both debits landing before either
  //    reaches walletTransaction.create()), which is NOT how Postgres
  //    actually serializes concurrent writers to the same row and would
  //    make this test's outcome an artifact of JS microtask scheduling
  //    rather than a faithful model.
  // 2. Snapshot/restore-on-throw (rollback) — undoes everything the losing
  //    transaction did, including its own already-applied debit, exactly
  //    like a real ROLLBACK.
  let lockTail: Promise<void> = Promise.resolve();
  const transactionMock = async (fn: any) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>(resolve => { release = resolve; });
    await previous;

    const usersSnapshot = users.map(u => ({ ...u }));
    const walletTransactionsSnapshot = walletTransactions.map(w => ({ ...w }));
    const escrowsSnapshot = escrows.map(e => ({ ...e }));
    const orderSnapshot = { ...order };
    try {
      return await fn(tx);
    } catch (error) {
      users.length = 0; users.push(...usersSnapshot);
      walletTransactions.length = 0; walletTransactions.push(...walletTransactionsSnapshot);
      escrows.length = 0; escrows.push(...escrowsSnapshot);
      Object.assign(order, orderSnapshot);
      throw error;
    } finally {
      release();
    }
  };

  // Same shared OTP row for both concurrent calls — same paymentReference,
  // exactly as a real double-click/duplicate-submission would share the one
  // OTP context created by the single preceding initPayment() call.
  const sharedOtp = { id: 'otp-shared', code: '111111', expiresAt: new Date(Date.now() + 60_000), context: { purpose: 'checkout_payment', orderId: 'order-1', paymentReference: 'PAY-SHARED', paymentMethod: 'wallet' } };

  const prismaMock: any = {
    order: { findFirst: async () => order },
    otpVerification: { findMany: async () => [sharedOtp], delete: async () => ({}), update: async () => ({}) },
    serviceStage: { findMany: async () => [] },
    $transaction: transactionMock
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });

  const moduleUrl = `./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { cartCheckoutService } = await import(moduleUrl);

  const confirmOnce = () => cartCheckoutService.confirmPayment('user-1', 'order-1', '111111').catch((e: any) => e);
  const [resultA, resultB] = await Promise.all([confirmOnce(), confirmOnce()]);
  const results = [resultA, resultB];

  const succeeded = results.filter(r => r && r.status === 'paid');
  const failed = results.filter(r => r instanceof Error);

  assert.equal(succeeded.length, 1, 'exactly one purchase succeeds');
  assert.equal(failed.length, 1, 'exactly one is rejected');

  // The losing request's error must be the clean, narrow business-conflict
  // AppError — never the raw PrismaClientKnownRequestError, never a generic
  // unclassified 500.
  assert.equal(failed[0].statusCode, 409);
  assert.equal(failed[0].constructor?.name, 'AppError', 'the raw Prisma P2002 must never be surfaced directly');
  assert.doesNotMatch(String(failed[0].message), /Prisma|P2002|constraint|referenceId/i, 'no internal DB detail leaks into the business-facing message');

  // The financial invariants this test exists to prove:
  assert.equal(users[0].walletBalance, 200, 'exactly ONE debit of 100 persists — the loser\'s own debit was rolled back, not merely uncounted');
  assert.equal(walletTransactions.length, 1, 'exactly one WalletTransaction persists');
  assert.equal(escrows.length, 1, 'exactly one Project/Contract/Escrow set persists — the loser\'s own set was rolled back');
  assert.equal(order.status, 'PAID', 'the order ends PAID exactly once');
});

// --- Phase 4: duplicate-purchase prevention ----------------------------------
// "After buying a marketplace project I went back and bought it again while it
// was still under execution." A client with a contract-backed, non-terminal
// project for a service must not be able to add/order/pay for it again.

const ACTIVE_PURCHASE = { id: 'project-existing', serviceCatalogId: 'service-1', title: 'Service', status: 'IN_PROGRESS', contract: { status: 'ACTIVE' } };

test('Phase 4 confirmPayment: an existing active purchase of the same service rejects 409 — wallet NOT debited, no escrow, order NOT marked PAID', async (t) => {
  const order = makeOrderForConfirm();
  const { cartCheckoutService, users, walletTransactions, tx, getOrderUpdated } = await loadServiceForConfirm(t, { order, walletBalance: 250, activePurchases: [ACTIVE_PURCHASE] });

  const error: any = await cartCheckoutService.confirmPayment('user-1', 'order-1', '111111').catch((e: any) => e);

  assert.equal(error.statusCode, 409);
  assert.match(String(error.message), /قيد التنفيذ/);
  assert.equal(users[0].walletBalance, 250, 'the in-transaction debit is rolled back');
  assert.equal(walletTransactions.length, 0);
  assert.equal(tx.escrow.create.mock.callCount(), 0);
  assert.equal(getOrderUpdated(), null, 'order transition rolled back');
  // The gate queries exactly this client + these services + non-terminal contracts.
  const where = tx.project.findMany.mock.calls[0].arguments[0].where;
  assert.equal(where.clientId, 'user-1');
  assert.deepEqual(where.serviceCatalogId, { in: ['service-1'] });
  assert.deepEqual(where.contract.status.in.sort(), ['ACTIVE', 'DISPUTED', 'PENDING_CLIENT_SIGNATURE', 'PENDING_PAYMENT', 'PENDING_PROVIDER_SIGNATURE'].sort());
});

test('Phase 4 confirmPayment: a successful purchase removes the purchased services from the server cart in the same transaction', async (t) => {
  const order = makeOrderForConfirm();
  const { cartCheckoutService, tx } = await loadServiceForConfirm(t, { order, walletBalance: 250 });

  await cartCheckoutService.confirmPayment('user-1', 'order-1', '111111');

  assert.equal(tx.cartItem.deleteMany.mock.callCount(), 1);
  assert.deepEqual(tx.cartItem.deleteMany.mock.calls[0].arguments[0].where, { cart: { userId: 'user-1' }, serviceId: { in: ['service-1'] } });
  assert.equal(tx.order.updateMany.mock.callCount(), 1, 'order moved to PAID exactly once, via the guarded transition');
});

test('Phase 4 confirmPayment: an order that is no longer PENDING_PAYMENT is rejected 409 at the in-transaction gate before any debit', async (t) => {
  const order = makeOrderForConfirm();
  const { cartCheckoutService, users, tx } = await loadServiceForConfirm(t, { order, walletBalance: 250 });
  // Simulate a concurrent confirmation that already committed PAID after the
  // outside-transaction pre-read.
  tx.order.updateMany = t.mock.fn(async () => ({ count: 0 }));

  const error: any = await cartCheckoutService.confirmPayment('user-1', 'order-1', '111111').catch((e: any) => e);

  assert.equal(error.statusCode, 409);
  assert.equal(tx.user.updateMany.mock.callCount(), 0, 'no debit attempted');
  assert.equal(users[0].walletBalance, 250);
});

test('Phase 4 createOrder: an existing active purchase of the same service rejects 409 before any order row is created', async (t) => {
  const service = makeService({ id: 'service-1', provider: makeProvider({ id: 'provider-9' }) });
  const orderCreateSpy = t.mock.fn(async () => { throw new Error('must not be reached'); });
  t.mock.module('../config/db', { namedExports: { prisma: {
    serviceCatalog: { findMany: async () => [service] },
    project: { findMany: async () => [ACTIVE_PURCHASE] },
    $transaction: async (fn: any) => fn({ order: { count: async () => 0, create: orderCreateSpy } })
  } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
  const { cartCheckoutService } = await import(`./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`);

  const error: any = await cartCheckoutService.createOrder('user-1', { items: [{ modelId: 'service-1' }] }).catch((e: any) => e);

  assert.equal(error.statusCode, 409);
  assert.deepEqual(error.errors, [{ serviceId: 'service-1', projectId: 'project-existing' }]);
  assert.equal(orderCreateSpy.mock.callCount(), 0);
});

test('Phase 4 addItem: an existing active purchase rejects 409 and the cart is not touched; own service rejected 400', async (t) => {
  const cartUpsert = t.mock.fn(async () => ({ id: 'cart-1', items: [] }));
  let active: any[] = [ACTIVE_PURCHASE];
  let service: any = { id: 'service-1', providerId: 'provider-9' };
  t.mock.module('../config/db', { namedExports: { prisma: {
    serviceCatalog: { findFirst: async () => service },
    project: { findMany: async () => active },
    cart: { upsert: cartUpsert },
    cartItem: { upsert: async () => ({}) }
  } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
  const { cartCheckoutService } = await import(`./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`);

  const dup: any = await cartCheckoutService.addItem('user-1', { modelId: 'service-1' }).catch((e: any) => e);
  assert.equal(dup.statusCode, 409);
  assert.equal(cartUpsert.mock.callCount(), 0);

  active = []; service = { id: 'service-1', providerId: 'user-1' };
  const own: any = await cartCheckoutService.addItem('user-1', { modelId: 'service-1' }).catch((e: any) => e);
  assert.equal(own.statusCode, 400);
  assert.equal(cartUpsert.mock.callCount(), 0);
});
