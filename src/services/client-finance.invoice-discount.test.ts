import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { splitRelease, commissionOn, providerNetEntitlement } from '../utils/escrow-commission';
import { splitByWeights } from '../utils/order-discount';

// The invoice of a purchase made with a provider coupon shows: service value 20, coupon discount -2, total paid 18 (tax stays 0). A purchase without a coupon is unchanged.
const delivery = (o: any = {}) => ({ id: 'del-1', status: 'APPROVED', submittedAt: new Date('2026-10-13T16:27:19Z'), reviewedAt: new Date('2026-10-13T16:27:38Z'), ...o });
const contract = (terms: any, stages: any[]) => ({
  id: 'contract-1', projectId: 'project-1', status: 'COMPLETED', signedAt: new Date(), price: 18, terms,
  project: { title: 'QA service' }, provider: { firstName: 'نورة', lastName: 'م', commercialRegistration: null, vatCertificateUrl: null },
  stages
});
const stage = (amount: number, id = 'st-1') => ({ id, title: 'مرحلة', amount, status: 'APPROVED', approvedAt: new Date('2026-10-13T16:27:38Z'), deliveries: [delivery()] });
const TERMS = { source: 'marketplace_order', orderId: 'o1', orderNumber: 'WS-1', couponCode: 'QAC2TEN', listPrice: 20, discount: 2, netPrice: 18 };

async function load(t: TestContext, c: any) {
  t.mock.module('../config/db', { namedExports: { prisma: { contract: { findMany: async () => [c] }, stageDelivery: { findFirst: async () => ({ ...delivery(), stage: { ...stage(c.stages[0].amount), contract: c } }) } } } });
  const { clientFinanceService } = await import(`./client-finance.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return clientFinanceService;
}

test('coupon purchase: invoice = service value 20, discount 2 (code shown), total paid 18, tax 0', async (t) => {
  const svc = await load(t, contract(TERMS, [stage(18)]));
  const inv = (await svc.getInvoices('client-1')).invoices[0];
  assert.deepEqual([inv.subtotal, inv.discount, inv.total, inv.tax, inv.couponCode], [20, 2, 18, 0, 'QAC2TEN']);
});

test('the single-invoice endpoint returns the same breakdown', async (t) => {
  const svc = await load(t, contract(TERMS, [stage(18)]));
  const inv = await svc.getInvoice('client-1', 'del-1');
  assert.deepEqual([inv.subtotal, inv.discount, inv.total], [20, 2, 18]);
});

test('multi-stage: each stage invoice shows its share of the service value (stage 10.8 of net 18 => 12 of 20, discount 1.2)', async (t) => {
  const svc = await load(t, contract(TERMS, [stage(10.8, 'st-1')]));
  const inv = (await svc.getInvoices('client-1')).invoices[0];
  assert.deepEqual([inv.subtotal, inv.discount, inv.total], [12, 1.2, 10.8]);
});

test('no coupon (no terms): subtotal = total, discount 0, no code — unchanged', async (t) => {
  const svc = await load(t, contract(null, [stage(20)]));
  const inv = (await svc.getInvoices('client-1')).invoices[0];
  assert.deepEqual([inv.subtotal, inv.discount, inv.total, inv.couponCode], [20, 0, 20, null]);
});

test('release maths on the NET: commission is taken on 18 (not 20) and the provider gets 18 minus that', () => {
  const rate = 12.75;
  assert.equal(commissionOn(18, rate), 2.3); // round2(2.295)
  assert.equal(providerNetEntitlement(18, rate), 15.7);
  // a 2-stage net split (10.8 + 7.2): the releases add up to exactly the net entitlement
  const [s1, s2] = splitByWeights([12, 8], 18);
  const r1 = splitRelease({ grossReleasedBefore: 0, commissionTotalBefore: 0, grossReleasedAfter: s1, ratePercent: rate });
  const r2 = splitRelease({ grossReleasedBefore: s1, commissionTotalBefore: r1.commissionTotalAfter, grossReleasedAfter: 18, ratePercent: rate });
  assert.equal(r1.gross + r2.gross, 18);
  assert.equal(Math.round((r1.net + r2.net) * 100) / 100, 15.7);
  assert.equal(r2.netReleasedAfter, 15.7);
});
