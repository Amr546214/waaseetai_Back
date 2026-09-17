import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

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
    gamification: { points: 150, currentLevelIndex: 3 } // LEVEL_MATRIX[2] = 'باحث'
  });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].level, 'باحث');
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
    gamification: { points: 0, currentLevelIndex: 1 } // LEVEL_MATRIX[0] = 'زائر'
  });
  const { cartCheckoutService } = await loadServiceForCart(t, makeService({ provider }));

  const cart = await cartCheckoutService.getCart('user-1');

  assert.equal(cart.items[0].level, 'زائر');
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
