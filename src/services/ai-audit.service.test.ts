import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VERDICT = { isApproved: true, score: 87.6, summary: 'ملخص', strengths: ['a'], issues: ['b'], recommendations: ['c'] };

function makeModel(over: any = {}) {
  return {
    id: 'svc-1', title: 'T', description: 'D', totalAmount: '150.50', totalDays: 14, subSpecialty: null,
    specialty: { nameAr: 'تطوير المواقع' },
    stages: [{ stepOrder: 1, title: 'تحليل', deliveryDays: 4, percentage: 30 }, { stepOrder: 2, title: 'تنفيذ', deliveryDays: 10, percentage: 70 }],
    ...over,
  };
}

async function load(t: TestContext, opts: { model?: any; audit?: (b: any) => Promise<any>; configured?: boolean; list?: any[]; counts?: number[] } = {}) {
  const calls: any[] = [];
  const updates: any[] = [];
  const models = new Map<string, any>();
  const prisma = {
    serviceCatalog: {
      findUnique: async () => ('model' in opts ? opts.model : makeModel()),
      update: async (a: any) => { updates.push(a); return {}; },
      findMany: async () => opts.list ?? [],
      count: async () => (opts.counts ?? [0, 0]).shift() ?? 0,
    },
  };
  void models;
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        isConfigured: () => opts.configured !== false,
        auditBusinessModel: async (b: any) => { calls.push(b); return opts.audit ? opts.audit(b) : VERDICT; },
      },
    },
  });
  const mod = await import(`./ai-audit.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { svc: mod.aiAuditService as import('./ai-audit.service').AiAuditService, calls, updates, t };
}

test('sends DB category, title, number amount and stages block; no currency', async (t) => {
  const { svc, calls } = await load(t);
  await svc.executeAuditSync('svc-1');
  assert.equal(calls.length, 1);
  const b = calls[0];
  assert.equal(b.category, 'تطوير المواقع');
  assert.equal(b.title, 'T');
  assert.deepEqual(b.pricing, { amount: 150.5 });
  assert.equal(typeof b.pricing.amount, 'number');
  assert.deepEqual(Object.keys(b).sort(), ['category', 'description', 'pricing', 'title']);
  assert.match(b.description, /^D\n/);
  assert.match(b.description, /14 يوم/);
  assert.match(b.description, /1\. تحليل \(4 يوم، 30%\)/);
  assert.match(b.description, /2\. تنفيذ \(10 يوم، 70%\)/);
});

test('sub-specialty is appended to the category', async (t) => {
  const { svc, calls } = await load(t, { model: makeModel({ subSpecialty: 'متاجر' }) });
  await svc.executeAuditSync('svc-1');
  assert.equal(calls[0].category, 'تطوير المواقع - متاجر');
});

test('persists advisory fields only; never status/approvedAt/auditRejectionReason; clarity/feasibility untouched', async (t) => {
  const { svc, updates } = await load(t);
  const r = await svc.executeAuditSync('svc-1');
  assert.deepEqual(r, { outcome: 'audited', serviceId: 'svc-1', score: 87.6, isApproved: true });
  assert.equal(updates.length, 1);
  const d = updates[0].data;
  assert.deepEqual(Object.keys(d).sort(), ['aiAuditFeedback', 'aiAuditReport', 'aiAuditScore', 'aiReviewDetails', 'aiReviewSummary', 'aiScore']);
  for (const k of ['status', 'approvedAt', 'auditRejectionReason', 'aiClarityScore', 'aiFeasibilityScore']) assert.ok(!(k in d), k);
  assert.equal(d.aiScore, 88);
  assert.equal(d.aiAuditScore, 87.6);
  assert.equal(d.aiReviewSummary, 'ملخص');
  assert.deepEqual(d.aiReviewDetails, { source: 'WASEET_AI', strengths: ['a'], issues: ['b'], recommendations: ['c'] });
  assert.deepEqual(d.aiAuditReport, { source: 'WASEET_AI', isApproved: true, score: 87.6, summary: 'ملخص', strengths: ['a'], issues: ['b'], recommendations: ['c'] });
  assert.deepEqual(d.aiAuditFeedback, { summary: 'ملخص', recommendations: ['c'] });
});

test('isApproved=false is still advisory (no status/rejection write)', async (t) => {
  const { svc, updates } = await load(t, { audit: async () => ({ ...VERDICT, isApproved: false, score: 10 }) });
  await svc.executeAuditSync('svc-1');
  assert.ok(!('status' in updates[0].data) && !('auditRejectionReason' in updates[0].data));
});

test('no specialty -> skipped, no call, no write', async (t) => {
  const { svc, calls, updates } = await load(t, { model: makeModel({ specialty: null }) });
  const r = await svc.executeAuditSync('svc-1');
  assert.deepEqual(r, { outcome: 'skipped', serviceId: 'svc-1', reason: 'NO_CATEGORY' });
  assert.equal(calls.length, 0);
  assert.equal(updates.length, 0);
});

test('upstream failure throws 503 with normalized code and writes nothing (no upstream text)', async (t) => {
  const { svc, updates } = await load(t, { audit: async () => { throw new Error('secret upstream text'); } });
  await assert.rejects(() => svc.executeAuditSync('svc-1'), (e: any) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, 'UNKNOWN_PROVIDER_ERROR');
    assert.ok(!/secret/.test(e.message));
    return true;
  });
  assert.equal(updates.length, 0);
});

const BAD_RESPONSES: Record<string, any> = {
  null: null, 'score string': { ...VERDICT, score: 'x' }, 'score>100': { ...VERDICT, score: 101 },
  'isApproved string': { ...VERDICT, isApproved: 'yes' }, 'issues missing': { ...VERDICT, issues: undefined },
};
for (const [name, bad] of Object.entries(BAD_RESPONSES)) {
  test(`invalid response (${name}) throws 503 INVALID_RESPONSE and writes nothing`, async (t) => {
    const { svc, updates } = await load(t, { audit: async () => bad });
    await assert.rejects(() => svc.executeAuditSync('svc-1'), (e: any) => e.statusCode === 503 && e.code === 'INVALID_RESPONSE');
    assert.equal(updates.length, 0);
  });
}

test('missing model -> 404, no call', async (t) => {
  const { svc, calls } = await load(t, { model: null });
  await assert.rejects(() => svc.executeAuditSync('x'), (e: any) => e.statusCode === 404);
  assert.equal(calls.length, 0);
});

test('creation hooks never throw and do not block', async (t) => {
  const { svc } = await load(t, { audit: async () => { throw new Error('boom'); } });
  await svc.auditProjectModel('svc-1');
  await svc.triggerAuditAndPublish('svc-1', 'p');
  await new Promise((r) => setTimeout(r, 20));
});

async function loadController(t: TestContext, opts: any) {
  const ctx = await load(t, opts);
  const execs: string[] = [];
  const results: Record<string, any> = opts.results ?? {};
  t.mock.module('../services/ai-audit.service', {
    namedExports: {
      aiAuditService: {
        executeAuditSync: async (id: string) => {
          execs.push(id);
          const r = results[id] ?? { outcome: 'audited' };
          if (r === 'throw') throw Object.assign(new Error('upstream detail'), { code: 'TIMEOUT' });
          return r;
        },
      },
    },
  });
  const { MarketplaceServiceController } = await import(`../controllers/marketplace-service.controller.ts?fixture=${Date.now()}-${Math.random()}`) as any;
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  return { ctrl: new MarketplaceServiceController(), res, execs };
}

test('re-audit-all: counts audited/failed/skipped/remaining, no upstream text', async (t) => {
  const { ctrl, res, execs } = await loadController(t, {
    list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    counts: [10, 2],
    results: { b: 'throw', c: { outcome: 'skipped', reason: 'NO_CATEGORY' } },
  });
  await ctrl.reAuditAllPendingModels({} as any, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, audited: 1, failed: 1, skipped: 3, remaining: 8 });
  assert.deepEqual(execs, ['a', 'b', 'c']);
  assert.ok(!JSON.stringify(res.body).includes('upstream'));
});

test('re-audit-all: batch is capped at 25 and statuses include PUBLISHED (services are created PUBLISHED)', async (t) => {
  const src = readFileSync(new URL('../controllers/marketplace-service.controller.ts', import.meta.url), 'utf8');
  assert.match(src, /RE_AUDIT_BATCH_SIZE = 25/);
  assert.match(src, /\['PENDING_APPROVAL', 'UNDER_REVIEW', 'DRAFT', 'PUBLISHED'\]/);
  assert.match(src, /take: RE_AUDIT_BATCH_SIZE/);
});

test('re-audit-all: not configured -> 503 AI_FEATURE_UNAVAILABLE, nothing read', async (t) => {
  const { ctrl, res, execs } = await loadController(t, { configured: false, list: [{ id: 'a' }] });
  await ctrl.reAuditAllPendingModels({} as any, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AI_FEATURE_UNAVAILABLE');
  assert.equal(execs.length, 0);
});

test('route auth/limiter unchanged', () => {
  const src = readFileSync(new URL('../routes/business-models.routes.ts', import.meta.url), 'utf8');
  assert.match(src, /router\.post\('\/re-audit-all', authenticate, requireActiveUser, authorize\(AccountType\.SUPER_ADMIN, AccountType\.ADMIN\), aiLimiter, controller\.reAuditAllPendingModels/);
});

test('no Gemini reference in audit service/controller', () => {
  for (const f of ['./ai-audit.service.ts', '../controllers/marketplace-service.controller.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /gemini/i);
  }
});

// ── BE-2(c): advisory async audit on service create/update ──────────────────
test('auditProjectModel returns immediately, audits in the background and never throws on vendor failure', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { svc, calls, updates } = await load(t, { audit: async () => { await gate; return VERDICT; } });
  await svc.auditProjectModel('svc-1'); // resolves while the vendor call is still pending
  assert.equal(updates.length, 0);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, undefined); // advisory only
});

test('auditProjectModel: vendor failure leaves aiScore unwritten (null) and does not throw', async (t) => {
  const { svc, updates } = await load(t, { audit: async () => { throw new Error('down'); } });
  await assert.doesNotReject(svc.auditProjectModel('svc-1'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updates.length, 0);
});

test('auditProjectModel: a second trigger for the same model while one is running does not stack a vendor call', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { svc, calls } = await load(t, { audit: async () => { await gate; return VERDICT; } });
  await svc.auditProjectModel('svc-1');
  await svc.auditProjectModel('svc-1');
  await new Promise((r) => setTimeout(r, 10));
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
});

test('create/update of a service trigger the advisory audit; update clears the stale verdict first', () => {
  const src = readFileSync(new URL('./marketplace-service.service.ts', import.meta.url), 'utf8');
  assert.equal((src.match(/void aiAuditService\.auditProjectModel\(/g) || []).length, 2);
  assert.match(src, /aiScore: null,[\s\S]*aiAuditReport: Prisma\.DbNull/);
  assert.doesNotMatch(src, /aiAuditService\.executeAuditSync/); // never awaited inline
});
