import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// POST /api/business-models/publish with a modelId: the owner may publish only a model that is allowed to be live (DRAFT / APPROVED /
// already PUBLISHED). REJECTED / UNDER_REVIEW / PENDING_* / ARCHIVED can never be flipped to PUBLISHED by the provider.

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

async function load(t: TestContext, status: string) {
  const update = t.mock.fn(async (a: any) => ({ id: 'm1', status: a.data.status }));
  const prisma: any = { serviceCatalog: { findFirst: async (a: any) => (a.where.providerId === 'p1' ? { id: 'm1', providerId: 'p1', status, approvedAt: null } : null), update } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('../services/marketplace-service.service', { namedExports: { MarketplaceService: class {} } });
  const { MarketplaceServiceController } = await import(`./marketplace-service.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const controller: any = new MarketplaceServiceController();
  return { controller, update };
}
const publish = async (controller: any, body: any) => { const r = res(); await controller.publishBusinessModel({ user: { id: 'p1' }, body } as any, r); return r; };

for (const blocked of ['REJECTED', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'PENDING_SIGNATURE', 'ARCHIVED']) {
  test(`a ${blocked} model cannot be republished by its owner (409, nothing written)`, async (t) => {
    const { controller, update } = await load(t, blocked);
    const r = await publish(controller, { modelId: 'm1' });
    assert.equal(r.statusCode, 409);
    assert.equal(update.mock.callCount(), 0);
  });
}

for (const allowed of ['DRAFT', 'APPROVED', 'PUBLISHED']) {
  test(`a ${allowed} model can be published by its owner`, async (t) => {
    const { controller, update } = await load(t, allowed);
    const r = await publish(controller, { modelId: 'm1' });
    assert.equal(r.statusCode, 200);
    assert.equal(update.mock.calls[0].arguments[0].data.status, 'PUBLISHED');
  });
}

test('another provider\'s model is not found (404)', async (t) => {
  const { controller, update } = await load(t, 'DRAFT');
  const r = res();
  await controller.publishBusinessModel({ user: { id: 'someone-else' }, body: { modelId: 'm1' } } as any, r);
  assert.equal(r.statusCode, 404);
  assert.equal(update.mock.callCount(), 0);
});
