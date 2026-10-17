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

// ---- invoice lifecycle: due after delivery, paid after approval, 404 for a missing / someone else's invoice ----
async function loadLifecycle(t: TestContext, o: { stageStatus: string; deliveryStatus: string; found?: boolean }) {
  const st = { ...stage(18), status: o.stageStatus, approvedAt: o.stageStatus === 'APPROVED' ? new Date('2026-10-13T16:27:38Z') : null };
  const del = delivery({ status: o.deliveryStatus, reviewedAt: o.deliveryStatus === 'APPROVED' ? new Date('2026-10-13T16:27:38Z') : null });
  const c = { ...contract(null, [{ ...st, deliveries: [del] }]) };
  t.mock.module('../config/db', { namedExports: { prisma: { contract: { findMany: async () => [c] }, stageDelivery: { findFirst: async (args: any) => (o.found === false || args.where.stage.contract.clientId !== 'client-1' ? null : { ...del, stage: { ...st, contract: c } }) } } } });
  const { clientFinanceService } = await import(`./client-finance.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return clientFinanceService;
}

test('invoice right after delivery (not yet approved) is DUE with no payment date; after the client approves it is PAID with the approval date', async t => {
  const before = (await (await loadLifecycle(t, { stageStatus: 'SUBMITTED', deliveryStatus: 'SUBMITTED' })).getInvoices('client-1')).invoices[0];
  assert.equal(before.status, 'due');
  assert.equal(before.paymentDate, null);
});
test('invoice after delivery approval is paid, shows service value / discount / total and tax 0 (no VAT claim)', async t => {
  const svc = await loadLifecycle(t, { stageStatus: 'APPROVED', deliveryStatus: 'APPROVED' });
  const inv = await svc.getInvoice('client-1', 'del-1');
  assert.equal(inv.status, 'paid');
  assert.ok(inv.paymentDate);
  assert.deepEqual([inv.subtotal, inv.discount, inv.total, inv.tax, inv.taxRate], [18, 0, 18, 0, 0]);
});
test('invoice not found (or another client\'s) is 404', async t => {
  const svc = await loadLifecycle(t, { stageStatus: 'APPROVED', deliveryStatus: 'APPROVED', found: false });
  await assert.rejects(svc.getInvoice('client-1', 'nope'), (e: any) => e.statusCode === 404);
});
test('another client\'s invoice is 404 too (ownership is in the query)', async t => {
  const other = await loadLifecycle(t, { stageStatus: 'APPROVED', deliveryStatus: 'APPROVED' });
  await assert.rejects(other.getInvoice('client-2', 'del-1'), (e: any) => e.statusCode === 404);
});
