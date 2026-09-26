import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 7 — replaces team-deliveries.ts's fully hardcoded
// "company deliveries" list (7 fictional entries with fabricated aiMatchPct
// values 94/97/91/99/96/97/94 attributed to 3 made-up team members, e.g.
// "فهد العتيبي"). These tests prove the real replacement returns genuine
// StageDelivery data with no fabricated match score and no team-member
// attribution anywhere in the response shape.

function deliveryFixture(overrides: Partial<any> = {}) {
  return {
    id: 'delivery-1',
    providerId: 'provider-1',
    note: 'تم رفع الملفات النهائية.',
    files: ['file-a.zip'],
    status: 'SUBMITTED',
    submittedAt: new Date('2024-05-01T00:00:00.000Z'),
    stage: {
      title: 'واجهة المستخدم',
      stepOrder: 2,
      amount: 4500,
      contract: {
        id: 'contract-abcdef123456',
        phasesCount: 5,
        project: { title: 'متجر أغذية' },
      },
    },
    ...overrides,
  };
}

async function loadService(t: TestContext, deliveries: any[]) {
  const findManyArgs: any[] = [];
  const prismaMock: any = {
    stageDelivery: {
      findMany: async (args: any) => {
        findManyArgs.push(args);
        return deliveries;
      },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./provider-deliveries.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.providerDeliveriesService, findManyArgs };
}

test('getCompanyDeliveries: scopes the query to the given provider only', async t => {
  const { service, findManyArgs } = await loadService(t, []);
  await service.getCompanyDeliveries('provider-42');
  assert.deepEqual(findManyArgs[0].where, { providerId: 'provider-42' });
});

test('getCompanyDeliveries: maps real StageDelivery rows with no fabricated AI match score anywhere in the shape', async t => {
  const { service } = await loadService(t, [deliveryFixture()]);
  const result = await service.getCompanyDeliveries('provider-1');
  assert.equal(result.length, 1);
  const item = result[0];
  assert.equal(item.projectTitle, 'متجر أغذية');
  assert.equal(item.phaseLabel, 'واجهة المستخدم · المرحلة 2 من 5');
  assert.equal(item.status, 'SUBMITTED');
  assert.equal(item.statusLabel, 'بانتظار رد العميل');
  assert.equal(item.contractRef, 'CT-CONTRA');
  assert.equal(item.amountLabel, '4,500 ريال');
  assert.deepEqual(item.files, ['file-a.zip']);
  assert.equal(item.note, 'تم رفع الملفات النهائية.');

  const serialized = JSON.stringify(item);
  assert.doesNotMatch(serialized, /aiMatchPct|aiNote|memberId|memberName|memberInitials/i);
});

test('getCompanyDeliveries: maps every real StageDeliveryStatus to an honest Arabic label', async t => {
  const { service } = await loadService(t, [
    deliveryFixture({ id: 'd1', status: 'SUBMITTED' }),
    deliveryFixture({ id: 'd2', status: 'REVISION_REQUESTED' }),
    deliveryFixture({ id: 'd3', status: 'APPROVED' }),
  ]);
  const result = await service.getCompanyDeliveries('provider-1');
  assert.deepEqual(result.map((r: any) => r.statusLabel), [
    'بانتظار رد العميل',
    'بانتظار تعديل',
    'مكتمل ومُفرَج',
  ]);
});
