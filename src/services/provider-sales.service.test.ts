import { test } from 'node:test';
import assert from 'node:assert/strict';

test('provider sales: net of the coupon share, totals and top services', async t => {
  const orders = [
    { orderNumber: 'WS-1', status: 'COMPLETED', discount: 20, createdAt: new Date(), user: { firstName: 'أ', lastName: 'ب' }, items: [
      { id: 'i1aaaaaa', serviceId: 'sv1', modelId: 'sv1', title: 'خدمة 1', providerId: 'prov', price: 100 },
      { id: 'i2bbbbbb', serviceId: 'sv2', modelId: 'sv2', title: 'خدمة 2', providerId: 'other', price: 100 } ] },
    { orderNumber: 'WS-2', status: 'PAID', discount: 0, createdAt: new Date(), user: { firstName: 'ج', lastName: '' }, items: [
      { id: 'i3cccccc', serviceId: 'sv1', modelId: 'sv1', title: 'خدمة 1', providerId: 'prov', price: 50 } ] }
  ];
  t.mock.module('../config/db', { namedExports: { prisma: { order: { findMany: async () => orders } } } });
  const { providerSalesService } = await import(`./provider-sales.service.ts?f=${Date.now()}`);
  const r = await providerSalesService.getSales('prov');
  assert.equal(r.sales.length, 2);
  assert.equal(r.sales.find((s: any) => s.orderNumber === 'WS-1').amount, 90); // 100 − its half of the 20 discount
  assert.equal(r.summary.salesCount, 2);
  assert.equal(r.summary.totalRevenue, 140);
  assert.equal(r.topModels[0].name, 'خدمة 1');
  assert.equal(r.topModels[0].sales, 2);
});
