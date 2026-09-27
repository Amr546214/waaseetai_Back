import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3 Batch 2A — F4: analyzeProjectModel previously had no request-body
// validation at all (unlike its sibling suggestMilestones), so an empty
// payload could reach Gemini. This mirrors suggestMilestones' existing
// "title or description required" check exactly.

function fakeRes() {
  const res: any = { statusCode: undefined, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: any) => { res.body = payload; return res; };
  return res;
}

async function loadController(t: TestContext, opts: {
  analyzeProjectModel?: (payload: any) => Promise<any>;
} = {}) {
  const analyzeSpy = t.mock.fn(opts.analyzeProjectModel ?? (async () => ({ clarityScore: 80 })));
  t.mock.module('./ai-review.service', {
    namedExports: {
      AiReviewService: class {
        analyzeProjectModel = analyzeSpy;
      }
    }
  });

  const moduleUrl = `./ai-review.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const { AiReviewController } = await import(moduleUrl);
  return { controller: new AiReviewController(), analyzeSpy };
}

test('analyzeProjectModel: an empty payload is rejected with 400 and never reaches the service/Gemini', async (t) => {
  const { controller, analyzeSpy } = await loadController(t);
  const req: any = { body: {} };
  const res = fakeRes();
  let nextError: any;
  const next = (err: any) => { nextError = err; };

  await controller.analyzeProjectModel(req, res, next);

  assert.ok(nextError, 'next() must be called with an error');
  assert.equal(nextError.statusCode, 400);
  assert.equal(analyzeSpy.mock.callCount(), 0, 'the service (and therefore GeminiClient) must never be invoked for rejected input');
});

test('analyzeProjectModel: title and description both missing/empty is rejected with 400', async (t) => {
  const { controller, analyzeSpy } = await loadController(t);
  const req: any = { body: { title: '', description: '   '.trim(), category: 'تصميم' } };
  const res = fakeRes();
  let nextError: any;
  const next = (err: any) => { nextError = err; };

  await controller.analyzeProjectModel(req, res, next);

  assert.ok(nextError);
  assert.equal(nextError.statusCode, 400);
  assert.equal(analyzeSpy.mock.callCount(), 0);
});

test('analyzeProjectModel: a title-only payload is accepted and reaches the service (matches the existing intended contract)', async (t) => {
  const { controller, analyzeSpy } = await loadController(t, {
    analyzeProjectModel: async (payload) => { assert.equal(payload.title, 'مشروع تجريبي'); return { clarityScore: 90 }; }
  });
  const req: any = { body: { title: 'مشروع تجريبي' } };
  const res = fakeRes();
  const next = () => { throw new Error('next() must not be called for a valid request'); };

  await controller.analyzeProjectModel(req, res, next);

  assert.equal(analyzeSpy.mock.callCount(), 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('analyzeProjectModel: a description-only payload is accepted and reaches the service (matches the existing intended contract)', async (t) => {
  const { controller, analyzeSpy } = await loadController(t, {
    analyzeProjectModel: async (payload) => { assert.equal(payload.description, 'وصف تفصيلي كافٍ'); return { clarityScore: 70 }; }
  });
  const req: any = { body: { description: 'وصف تفصيلي كافٍ' } };
  const res = fakeRes();
  const next = () => { throw new Error('next() must not be called for a valid request'); };

  await controller.analyzeProjectModel(req, res, next);

  assert.equal(analyzeSpy.mock.callCount(), 1);
  assert.equal(res.statusCode, 200);
});

test('analyzeProjectModel: a full valid payload behaves exactly as before (existing valid path unchanged)', async (t) => {
  const analysis = { clarityScore: 82, feasibilityScore: 76, marketFitRating: 'High' };
  const { controller } = await loadController(t, {
    analyzeProjectModel: async () => analysis
  });
  const req: any = { body: { title: 'مشروع', description: 'وصف', category: 'تقنية', totalAmount: 4500 } };
  const res = fakeRes();
  const next = () => { throw new Error('next() must not be called for a valid request'); };

  await controller.analyzeProjectModel(req, res, next);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, message: 'Project model evaluated by Waseet AI successfully', data: analysis });
});
