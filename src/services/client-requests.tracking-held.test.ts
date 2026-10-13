import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// getActiveProjectTracking never reports an estimated held amount: it comes from a real HELD escrow only, and an unfunded project shows 0 held / 0 progress.
const NOW = new Date();
const request = { id: 'req-1', title: 'متجر', status: 'PENDING_SIGNATURE', expectedDurationDays: 10, updatedAt: NOW, proposals: [{ price: 950, provider: { firstName: 'سارة', lastName: 'ع', providerProfile: null } }] };

async function track(t: TestContext, escrow: any) {
  const db: any = {
    clientRequest: { findFirst: async () => request },
    escrow: { findUnique: async () => escrow },
    project: { findFirst: async () => null },
    contract: { findFirst: async () => null }
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return (await new ClientRequestsService().getActiveProjectTracking('client-1', 'req-1')).project;
}

test('no escrow: held amount 0 and no invented progress', async t => {
  const p = await track(t, null);
  assert.equal(p.heldAmount, 0);
  assert.equal(p.progress, 0);
});

test('a HELD escrow is the only source of the held amount (amount - released)', async t => {
  const p = await track(t, { status: 'HELD', amount: 950, releasedAmount: 200 });
  assert.equal(p.heldAmount, 750);
});

test('a refunded / released escrow holds nothing', async t => {
  assert.equal((await track(t, { status: 'REFUNDED', amount: 950, releasedAmount: 0 })).heldAmount, 0);
});
