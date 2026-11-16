import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// A provider's archived bid that never became a contract opens READ-ONLY (it used to be a 404 "not found / no permission"); anyone else still gets the 404.
async function load(t: TestContext, o: { proposal: any | null }) {
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../config/db', { namedExports: { prisma: {
    contract: { findFirst: async () => null },
    project: { findFirst: async () => null },
    projectProposal: { findFirst: async () => o.proposal },
  } } });
  const mod = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return mod.projectProgressService ?? new mod.ProjectProgressService();
}
const proposal = (status: string) => ({ status, totalPrice: 199, updatedAt: new Date(), project: { id: 'd8c68ff3-b9c0', title: 'بناء نظام تعليمي', deliveryDays: 30, client: { id: 'c1', firstName: 'كريم', lastName: 'محمد' }, escrow: null } });

test('cancelled before contracting: the provider sees the project, read-only, with the reason', async t => {
  const svc = await load(t, { proposal: proposal('CANCELLED') });
  const v = await svc.getProjectProgress('provider-1', 'd8c68ff3-b9c0');
  assert.equal(v.title, 'بناء نظام تعليمي'); assert.equal(v.role, 'provider'); assert.equal(v.statusLabel, 'ملغى قبل التعاقد'); assert.equal(v.status, 'CANCELLED');
  assert.equal(v.canUploadDelivery, false); assert.equal(v.canSubmitDelivery, false); assert.equal(v.readOnly, true); assert.equal(v.price, 199); assert.equal(v.clientName, 'كريم محمد');
  assert.deepEqual([v.stages, v.deliveries, v.messages, v.files], [[], [], [], []]);
});

test('a rejected bid says so; a project the user has no ended bid on is still a 404', async t => {
  const a = await load(t, { proposal: proposal('REJECTED') });
  assert.equal((await a.getProjectProgress('provider-1', 'p')).statusLabel, 'لم يُقبل عرضك');
});

test('no bid of this provider: 404', async t => {
  const svc = await load(t, { proposal: null });
  await assert.rejects(() => svc.getProjectProgress('stranger', 'p'), (e: any) => e.statusCode === 404);
});
