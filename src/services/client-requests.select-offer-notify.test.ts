import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// A1(b): selecting an offer moves the contract to the client-signature stage and tells the provider (once per distinct selection). A
// notification failure never fails the selection; the provider is never told about their own submission (no hook on offer creation).
const REQUEST = 'req-1', CLIENT = 'client-1', PROVIDER = 'prov-1', OFFER = 'offer-1';

function setup(t: TestContext, o: { existingContract?: any; notifyThrows?: boolean } = {}) {
  const calls: any[] = [];
  const tx: any = {
    clientRequest: { updateMany: async () => ({ count: 1 }), update: async () => ({}) },
    contract: { findUnique: async () => (o.existingContract ? { id: 'c1' } : null), updateMany: async () => ({ count: 1 }), upsert: async ({ create }: any) => ({ id: 'c1', status: 'PENDING_CLIENT_SIGNATURE', offerId: OFFER, ...create }) },
    proposal: { updateMany: async () => ({}) },
    projectProposal: { updateMany: async () => ({}) },
    project: { update: async () => ({}) }
  };
  const prismaMock: any = {
    clientRequest: { findFirst: async () => ({ id: REQUEST, title: 'متجر', status: 'OPEN' }) },
    proposal: { findFirst: async () => null },
    projectProposal: { findFirst: async () => ({ id: OFFER, providerId: PROVIDER, totalPrice: 500, deliveryDays: 10, milestones: [] }) },
    contract: { findUnique: async () => o.existingContract ?? null },
    escrow: { findUnique: async () => null },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { offerSelected: async (a: any) => { calls.push(a); if (o.notifyThrows) throw new Error('boom'); }, deliverStored: async () => {} } } });
  return calls;
}
const load = async () => {
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return new ClientRequestsService();
};

test('selectOffer notifies the provider with the frozen canonical offer id', async (t) => {
  const calls = setup(t);
  const r = await (await load()).selectOffer(CLIENT, REQUEST, OFFER);
  assert.equal(r.status, 'PENDING_CLIENT_SIGNATURE');
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0] }, { providerId: PROVIDER, offerId: OFFER, projectId: REQUEST, requestTitle: 'متجر' });
});

test('re-selecting the same offer on the same contract does not notify twice', async (t) => {
  const same = setup(t, { existingContract: { id: 'c1', status: 'PENDING_CLIENT_SIGNATURE', providerId: PROVIDER, offerId: OFFER } });
  await (await load()).selectOffer(CLIENT, REQUEST, OFFER);
  assert.equal(same.length, 0);
});

test('re-selecting with a different provider on the contract notifies the new provider', async (t) => {
  const other = setup(t, { existingContract: { id: 'c1', status: 'PENDING_CLIENT_SIGNATURE', providerId: 'someone-else', offerId: 'offer-9' } });
  await (await load()).selectOffer(CLIENT, REQUEST, OFFER);
  assert.equal(other.length, 1);
});

test('a refused selection (frozen contract) notifies nobody', async (t) => {
  const calls = setup(t, { existingContract: { id: 'c1', status: 'ACTIVE', providerId: PROVIDER, offerId: OFFER } });
  await assert.rejects(async () => (await load()).selectOffer(CLIENT, REQUEST, OFFER), (e: any) => e.statusCode === 409);
  assert.equal(calls.length, 0);
});
