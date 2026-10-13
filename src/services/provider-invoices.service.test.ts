import { test } from 'node:test';
import assert from 'node:assert/strict';

const prismaMock: any = {};
test('provider invoices: per-stage client / value / commission / net / status from the escrow snapshot', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { providerInvoicesService, splitsForContract } = await import(`./provider-invoices.service.ts?f=${Date.now()}`);
  const escrow = { feePolicyVersion: 2, providerCommissionRateSnapshot: 10 };
  const stages = [
    { id: 's1', title: 'م1', amount: 100, status: 'APPROVED', approvedAt: new Date('2026-10-02') },
    { id: 's2', title: 'م2', amount: 200, status: 'SUBMITTED', approvedAt: null }
  ];
  const splits = splitsForContract(stages, escrow);
  assert.deepEqual(splits.get('s1'), { gross: 100, commission: 10, net: 90, estimated: false });
  assert.deepEqual(splits.get('s2'), { gross: 200, commission: 20, net: 180, estimated: true });
  assert.equal(splitsForContract(stages, { feePolicyVersion: null }).size, 0);

  const contract = { id: 'c1', projectId: 'p1', client: { firstName: 'نور', lastName: 'ع' }, project: { title: 'موقع', escrow }, stages: stages.map(s => ({ ...s, deliveries: [{ id: 'abcdef1234567890', submittedAt: new Date('2026-10-01'), reviewedAt: null }] })) };
  prismaMock.contract = { findMany: async () => [contract] };
  const res = await providerInvoicesService.list('prov');
  assert.equal(res.summary.totalCount, 2);
  assert.equal(res.summary.paidCount, 1);
  assert.equal(res.summary.paidNetTotal, 90);
  assert.equal(res.summary.dueNetTotal, 180);
  assert.equal(res.summary.platformCommissionTotal, 10);
  const paid = res.invoices.find((i: any) => i.status === 'paid');
  assert.equal(paid.clientName, 'نور ع');
  assert.equal(paid.stageValue, 100);
  assert.equal(paid.platformCommission, 10);
  assert.equal(paid.net, 90);
  const due = res.invoices.find((i: any) => i.status === 'due');
  assert.equal(due.commissionEstimated, true);
});

test('provider invoices: another provider\'s invoice is 404', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: { stageDelivery: { findFirst: async () => null } } } });
  const { providerInvoicesService } = await import(`./provider-invoices.service.ts?f=${Date.now()}b`);
  await assert.rejects(() => providerInvoicesService.get('prov', 'x'), (e: any) => e.statusCode === 404 || /غير موجودة/.test(e.message));
});

test('legacy escrow: no commission, net = stage value', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { buildProviderInvoice } = await import(`./provider-invoices.service.ts?f=${Date.now()}c`);
  const inv = buildProviderInvoice({ contract: { id: 'c', projectId: 'p', client: {}, project: { title: 'ت' } }, stage: { id: 's', title: 'م', amount: 50, status: 'APPROVED' }, delivery: { id: 'd1d1d1d1d1d1', submittedAt: new Date('2026-01-01') }, escrow: null, split: null });
  assert.equal(inv.platformCommission, 0);
  assert.equal(inv.net, 50);
});
