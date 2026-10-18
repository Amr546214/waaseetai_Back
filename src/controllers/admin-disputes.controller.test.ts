import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../utils/app-error';

test('admin-disputes.controller: getDisputeAiSummary returns 200 with data on success', async (t: TestContext) => {
  const summaryFixture = {
    summary: 'ملخص النزاع',
    clientPerspective: 'ادعاء العميل',
    providerPerspective: 'ادعاء مقدم الخدمة',
  };

  t.mock.module('../services/ai-features/dispute-summary.service', {
    namedExports: {
      disputeSummaryService: {
        generateSummary: async (id: string) => {
          assert.equal(id, 'disp-123');
          return summaryFixture;
        },
      },
    },
  });

  const { getDisputeAiSummary } = await import(`./admin-disputes.controller.ts?fixture=${Date.now()}-${Math.random()}`);

  const req: any = { params: { id: 'disp-123' } };
  let jsonOutput: any = null;
  const res: any = {
    json: (data: any) => { jsonOutput = data; },
    status: () => res,
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  await getDisputeAiSummary(req, res, next);

  assert.equal(nextCalled, false);
  assert.deepEqual(jsonOutput, { success: true, data: summaryFixture });
});

test('admin-disputes.controller: getDisputeAiSummary returns 502 when AI service fails', async (t: TestContext) => {
  t.mock.module('../services/ai-features/dispute-summary.service', {
    namedExports: {
      disputeSummaryService: {
        generateSummary: async () => {
          throw new Error('AI service down');
        },
      },
    },
  });

  const { getDisputeAiSummary } = await import(`./admin-disputes.controller.ts?fixture=${Date.now()}-${Math.random()}`);

  const req: any = { params: { id: 'disp-123' } };
  let statusCode = 200;
  let jsonOutput: any = null;
  const res: any = {
    status: (code: number) => { statusCode = code; return res; },
    json: (data: any) => { jsonOutput = data; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  await getDisputeAiSummary(req, res, next);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 502);
  assert.equal(jsonOutput.success, false);
  assert.match(jsonOutput.message, /تعذر إنشاء ملخص/);
});

test('admin-disputes.controller: getDisputeAiSummary forwards AppError (404) to next()', async (t: TestContext) => {
  const appError = new AppError('النزاع غير موجود', 404);
  t.mock.module('../services/ai-features/dispute-summary.service', {
    namedExports: {
      disputeSummaryService: {
        generateSummary: async () => {
          throw appError;
        },
      },
    },
  });

  const { getDisputeAiSummary } = await import(`./admin-disputes.controller.ts?fixture=${Date.now()}-${Math.random()}`);

  const req: any = { params: { id: 'disp-notfound' } };
  const res: any = {};
  let passedError: any = null;
  const next = (err: any) => { passedError = err; };

  await getDisputeAiSummary(req, res, next);

  assert.equal(passedError, appError);
  assert.equal(passedError.statusCode, 404);
});
