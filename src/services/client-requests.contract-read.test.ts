import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// The client contract page reads the FROZEN contract: price / duration / stages as selected (or as the accepted counter changed them), never the
// offers list, and it says whether signing is possible so the page can hide the sign button when it is not.
const CLIENT = 'client-1';
const terms = { version: 1, price: 1500, durationDays: 21, milestones: [
  { stepOrder: 1, title: 'التصميم', description: 'هوية', days: 7, amount: 500, percentage: 33.3 },
  { stepOrder: 2, title: 'التنفيذ', days: 14, amount: 1000, percentage: 66.7 }] };
const contract = (over: any = {}) => ({ id: 'c1', projectId: 'req-1', clientId: CLIENT, providerId: 'prov-1', offerId: 'offer-1', price: 1500, durationDays: 21, status: 'PENDING_CLIENT_SIGNATURE', terms, project: { title: 'مشروع الهوية' },
  provider: { id: 'prov-1', firstName: 'نورة', lastName: 'التصميم', providerProfile: null }, ...over });

async function read(t: TestContext, o: { contract?: any; ownRequest?: boolean; mirror?: boolean; escrow?: any; client?: string; offerId?: string }) {
  const c = o.contract === undefined ? contract() : o.contract;
  const prismaMock: any = {
    contract: { findFirst: async (a: any) => (c && a.where.clientId === (o.client ?? CLIENT) && c.clientId === a.where.clientId ? c : null) },
    clientRequest: { findFirst: async () => (o.ownRequest ? { id: 'req-1' } : null) },
    project: { findFirst: async () => null },
    proposal: { findFirst: async () => (o.mirror ? { id: 'legacy-1' } : null) },
    escrow: { findUnique: async () => o.escrow ?? null },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return new ClientRequestsService().getContractForSignature(o.client ?? CLIENT, 'req-1', o.offerId);
}

test('a ready contract returns the frozen price, duration and stages, and may be signed', async t => {
  const r: any = await read(t, {});
  assert.equal(r.ready, true);
  assert.equal(r.state, 'ready');
  assert.equal(r.price, 1500);
  assert.equal(r.durationDays, 21);
  assert.deepEqual(r.milestones.map((m: any) => [m.order, m.title, m.amount, m.days]), [[1, 'التصميم', 500, 7], [2, 'التنفيذ', 1000, 14]]);
  assert.equal(r.singleDelivery, false);
  assert.equal(r.provider.name, 'نورة التصميم');
  assert.equal(r.title, 'مشروع الهوية');
  assert.equal(r.otpTtlSeconds, 600);
});

test('a contract frozen without stages is a single delivery for the whole price (no invented stages)', async t => {
  const r: any = await read(t, { contract: contract({ terms: { version: 1 } }) });
  assert.deepEqual(r.milestones, []);
  assert.equal(r.singleDelivery, true);
});

test('no contract yet (no offer selected): not ready, with a clear message', async t => {
  const r: any = await read(t, { contract: null, ownRequest: true });
  assert.equal(r.ready, false);
  assert.equal(r.state, 'no_contract');
  assert.match(r.message, /اختيار عرض/);
});

test('a request that is not the client\'s is a 404 (nothing about it is revealed)', async t => {
  await assert.rejects(() => read(t, { contract: null, ownRequest: false }), (e: any) => (e.statusCode ?? e.status) === 404);
});

test('another client\'s contract is never returned (scoped by clientId)', async t => {
  await assert.rejects(() => read(t, { client: 'someone-else', ownRequest: false }), (e: any) => (e.statusCode ?? e.status) === 404);
});

test('a contract already signed and funded is not signable again and says who is awaited', async t => {
  const r: any = await read(t, { contract: contract({ status: 'PENDING_PROVIDER_SIGNATURE' }), escrow: { status: 'HELD' } });
  assert.equal(r.ready, false);
  assert.equal(r.state, 'awaiting_provider');
  assert.equal(r.escrowFunded, true);
});

test('an offer that is not the one the contract was frozen for is not signable; the mirror of the selected offer is', async t => {
  const bad: any = await read(t, { offerId: 'other-offer', mirror: false });
  assert.equal(bad.ready, false);
  assert.equal(bad.offerMatches, false);
});

test('the legacy mirror id of the selected offer matches the contract', async t => {
  const ok: any = await read(t, { offerId: 'legacy-1', mirror: true });
  assert.equal(ok.ready, true);
});
