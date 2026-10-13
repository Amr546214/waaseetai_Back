import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// A4 + A1(a): the client starts a negotiation on an offer. Only live offers can be negotiated (409 + Arabic reason + code otherwise); a real
// start tells the provider. One mocked prisma; the real chatService.initiateConversation runs.
const CLIENT = 'client-1', PROVIDER = 'prov-1', PROJECT = 'proj-1', OFFER = 'offer-1';
const PAYLOAD = { isNegotiation: true, negType: 'price', price: '900' };

function setup(t: TestContext, offerStatus: string, o: { legacyOnly?: boolean } = {}) {
  const calls: any = { negotiation: [] as any[], txWrites: 0, messages: [] as any[] };
  const conv = { id: 'conv-1', projectId: PROJECT, providerId: PROVIDER, clientId: CLIENT, messages: [], project: { title: 'متجر' }, client: { id: CLIENT, firstName: 'ع', lastName: 'م', avatarUrl: null, accountType: 'CLIENT_INDIVIDUAL' }, provider: { id: PROVIDER, firstName: 'ب', lastName: 'ج', avatarUrl: null, accountType: 'PROVIDER_INDIVIDUAL', providerProfile: null } };
  const offerRow = { id: OFFER, projectId: PROJECT, providerId: PROVIDER, status: offerStatus };
  const prismaMock: any = {
    user: { findUnique: async () => ({ id: CLIENT, accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', firstName: 'ع', lastName: 'م' }) },
    project: { findUnique: async () => ({ id: PROJECT, clientId: CLIENT, providerId: null, title: 'متجر' }) },
    clientRequest: { findUnique: async () => null },
    projectProposal: { findFirst: async () => (o.legacyOnly ? null : offerRow), findUnique: async () => offerRow, updateMany: () => { calls.txWrites++; return {}; } },
    proposal: { findFirst: async () => (o.legacyOnly ? offerRow : null), findUnique: async () => null, updateMany: () => { calls.txWrites++; return {}; } },
    $transaction: async (ops: any[]) => ops,
    conversation: { findUnique: async () => conv, create: async () => conv },
    message: { create: async ({ data }: any) => { calls.messages.push(data); return data; } }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { negotiationRequested: async (a: any) => { calls.negotiation.push(a); } } } });
  return calls;
}
const load = async () => (await import(`./chat.service.ts?f=${Date.now()}-${Math.random()}`)).chatService;

for (const [status, reason] of [['CANCELLED', /سحبه/], ['REJECTED', /مرفوض/], ['ACCEPTED', /مقبول/], ['PENDING_SIGNATURE', /بانتظار التوقيع/], ['DRAFT', /حالته الحالية/]] as const) {
  test(`negotiation on a ${status} offer is refused with 409 + Arabic reason + code, nothing is written or sent`, async (t) => {
    const calls = setup(t, status);
    const svc = await load();
    await assert.rejects(
      () => svc.initiateConversation(CLIENT, { projectId: PROJECT, providerId: PROVIDER, offerId: OFFER, negotiationPayload: PAYLOAD } as any),
      (e: any) => e.statusCode === 409 && reason.test(e.message) && e.errors?.[0]?.code === 'OFFER_NOT_NEGOTIABLE'
    );
    assert.equal(calls.txWrites, 0);
    assert.equal(calls.messages.length, 0);
    assert.equal(calls.negotiation.length, 0);
  });
}

for (const status of ['SUBMITTED', 'PENDING', 'UNDER_NEGOTIATION']) {
  test(`negotiation on a ${status} offer is allowed and the provider is notified with the offer id`, async (t) => {
    const calls = setup(t, status);
    const svc = await load();
    await svc.initiateConversation(CLIENT, { projectId: PROJECT, providerId: PROVIDER, offerId: OFFER, negotiationPayload: PAYLOAD } as any);
    assert.equal(calls.negotiation.length, 1);
    assert.deepEqual({ ...calls.negotiation[0] }, { providerId: PROVIDER, offerId: OFFER, projectId: PROJECT, requestTitle: 'متجر' });
    assert.ok(calls.messages.some((m: any) => String(m.content).startsWith('WS_NEGOTIATION::')));
  });
}

test('a legacy-only offer is guarded and notified the same way', async (t) => {
  setup(t, 'CANCELLED', { legacyOnly: true });
  await assert.rejects(() => (async () => (await load()).initiateConversation(CLIENT, { projectId: PROJECT, providerId: PROVIDER, offerId: OFFER, negotiationPayload: PAYLOAD } as any))(), (e: any) => e.statusCode === 409);
});

test('opening the chat without a negotiation payload does not notify the provider', async (t) => {
  const calls = setup(t, 'SUBMITTED');
  await (await load()).initiateConversation(CLIENT, { projectId: PROJECT, providerId: PROVIDER, offerId: OFFER } as any);
  assert.equal(calls.negotiation.length, 0);
});
