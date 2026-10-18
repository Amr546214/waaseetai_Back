import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MilestonesBreakdownService } from './milestones-breakdown.service';

const SAMPLE_MILESTONES_RESPONSE = {
  milestones: [
    { title: 'التصميم المبدئي وتجربة المستخدم', description: 'تسليم نماذج Figma الأولية', days: 5, percentage: 30, amount: 600 },
    { title: 'التطوير البرمجي للواجهات', description: 'ربط واجهات المستخدم بالـ API', days: 10, percentage: 40, amount: 800 },
    { title: 'الاختبار النهائي والتسليم', description: 'فحص الأداء وتثبيت المنظومة', days: 5, percentage: 30, amount: 600 },
  ],
};

function createMockClient(t: TestContext, opts: { suggestMilestones?: (req: any) => Promise<any> } = {}) {
  const suggestSpy = t.mock.fn(opts.suggestMilestones ?? (async () => SAMPLE_MILESTONES_RESPONSE));
  return {
    client: {
      suggestMilestones: suggestSpy,
      isConfigured: () => true,
    } as any,
    suggestSpy,
  };
}

test('generateBreakdown: calls Waseet AI and calculates exact percentages and total amounts', async (t) => {
  const { client, suggestSpy } = createMockClient(t);
  const { MilestonesBreakdownService } = await import(
    `./milestones-breakdown.service.ts?fixture=${Date.now()}-${Math.random()}`
  );
  const service = new MilestonesBreakdownService(client);

  const result = await service.generateBreakdown({
    title: 'تطوير متجر إلكتروني',
    description: 'بناء متجر متكامل مع بوابات الدفع',
    totalAmount: 2000,
    currency: 'USD',
  });

  assert.equal(suggestSpy.mock.calls.length, 1);
  assert.equal(result.totalAmount, 2000);
  assert.equal(result.milestones.length, 3);
  assert.equal(result.totalDays, 20);

  const sumAmounts = result.milestones.reduce((acc, m) => acc + m.amount, 0);
  assert.equal(sumAmounts, 2000);
});

test('breakdown rejects incomplete percentages, invalid days and a timeline longer than the supplied deadline', async () => {
  for (const milestones of [
    [{ title: 'A', description: 'Work', days: 1, percentage: 95 }],
    [{ title: 'A', description: 'Work', days: 1, percentage: -10 }, { title: 'B', description: 'Work', days: 1, percentage: 110 }],
    [{ title: 'A', description: 'Work', days: 1.5, percentage: 100 }],
    [{ title: 'A', description: 'Work', days: 0, percentage: 100 }],
    [{ title: 'A', description: 'Work', days: 5, percentage: 100 }],
  ]) {
    const service = new MilestonesBreakdownService({ suggestMilestones: async () => ({ milestones }) } as any);
    await assert.rejects(service.generateBreakdown({ title: 'Project', description: 'Work', totalAmount: 100, deliveryDays: 4 }),
      (error: any) => error.statusCode === 503);
  }
});

test('breakdown forwards deadline and conserves pennies with positive percentages without negative stage amounts', async () => {
  let body: any;
  const service = new MilestonesBreakdownService({ suggestMilestones: async (request: any) => {
    body = request;
    return { milestones: [33.3333, 33.3333, 33.3334].map((percentage, index) => ({ title: `Stage ${index}`, description: 'Work', days: 1, percentage })) };
  } } as any);
  const result = await service.generateBreakdown({ title: 'Project', description: 'Work', totalAmount: 0.02, deliveryDays: 3 });
  assert.equal(body.deliveryDays, 3);
  assert.equal(result.totalDays, 3);
  assert.equal(result.milestones.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), 2);
  assert.ok(result.milestones.every(item => item.amount >= 0));
});

test('breakdown refuses fractions smaller than a cent and invalid deadlines before calling the provider', async () => {
  let calls = 0;
  const service = new MilestonesBreakdownService({ suggestMilestones: async () => { calls++; return SAMPLE_MILESTONES_RESPONSE; } } as any);
  for (const input of [{ totalAmount: 0.001 }, { totalAmount: 10, deliveryDays: 0 }, { totalAmount: 10, deliveryDays: 1.5 }]) {
    await assert.rejects(service.generateBreakdown({ title: 'Project', description: 'Work', ...input }), (error: any) => error.statusCode === 400);
  }
  assert.equal(calls, 0);
});

test('generateBreakdown: validates required inputs with AppError 400', async (t) => {
  const { client } = createMockClient(t);
  const { MilestonesBreakdownService } = await import(
    `./milestones-breakdown.service.ts?fixture=${Date.now()}-${Math.random()}`
  );
  const service = new MilestonesBreakdownService(client);

  await assert.rejects(
    service.generateBreakdown({
      title: '',
      description: 'وصف',
      totalAmount: 1000,
    }),
    (err: any) => err.statusCode === 400
  );

  await assert.rejects(
    service.generateBreakdown({
      title: 'عنوان',
      description: 'وصف',
      totalAmount: 0,
    }),
    (err: any) => err.statusCode === 400
  );
});

test('generateBreakdown: translates upstream failures into AppError 503', async (t) => {
  const { client } = createMockClient(t, {
    suggestMilestones: async () => {
      throw new Error('Connection refused');
    },
  });
  const { MilestonesBreakdownService } = await import(
    `./milestones-breakdown.service.ts?fixture=${Date.now()}-${Math.random()}`
  );
  const service = new MilestonesBreakdownService(client);

  await assert.rejects(
    service.generateBreakdown({
      title: 'مشروع',
      description: 'تفاصيل',
      totalAmount: 500,
    }),
    (err: any) => err.statusCode === 503
  );
});
