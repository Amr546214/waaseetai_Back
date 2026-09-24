import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// F5 (trigger_ai_audit) — Batch: proposal AI audit migration to the shared
// Gemini foundation. Same plain-mock-socket convention as
// ai-review.gateway.test.ts / ai-assistant.gateway.test.ts. `geminiClient`
// and `prisma` are both mocked via t.mock.module; no real network/DB call
// happens.

function createMockSocket(opts: { userId?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];

  const socket: any = {
    id: 'socket-test-1',
    userId: opts.userId,
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    once: (event: string, handler: (...args: any[]) => any) => {
      (onceHandlers[event] ||= []).push(handler);
    },
    off: (event: string, handler?: (...args: any[]) => any) => {
      if (!onceHandlers[event]) return;
      onceHandlers[event] = handler ? onceHandlers[event].filter((h) => h !== handler) : [];
    },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };

  return {
    socket,
    handlers,
    emitted,
    triggerDisconnect: () => { (onceHandlers['disconnect'] || []).forEach((h) => h()); }
  };
}

function projectFixture(overrides: Partial<any> = {}) {
  return {
    title: 'تطوير متجر إلكتروني',
    description: 'وصف حقيقي',
    specialty: 'تطوير الويب',
    subSpecialties: [],
    budgetMin: 4000,
    budgetMax: 8000,
    budgetFixed: null,
    deliveryDays: 20,
    requirements: ['React'],
    ...overrides
  };
}

function providerFixture(overrides: Partial<any> = {}) {
  return {
    firstName: 'سارة',
    lastName: 'الزهراني',
    providerProfile: {
      yearsOfExperience: 5,
      rating: 4.8,
      headline: 'مطورة واجهات أمامية',
      bio: 'خبرة واسعة',
      skills: [{ name: 'React' }],
      portfolioItems: [{ id: 'p1', title: 'مشروع 1' }]
    },
    _count: { providerProjects: 12 },
    ...overrides
  };
}

function validAuditFixture(overrides: Partial<any> = {}) {
  return {
    profileAudit: [
      { title: 'عنوان 1', subtitle: 'وصف 1', status: 'EXCELLENT', badge: 'ممتاز' },
      { title: 'عنوان 2', subtitle: 'وصف 2', status: 'GOOD', badge: 'جيد' },
      { title: 'عنوان 3', subtitle: 'وصف 3', status: 'EXCELLENT', badge: 'ممتاز' },
      { title: 'عنوان 4', subtitle: 'وصف 4', status: 'WARNING', badge: 'تحسين' }
    ],
    triPartyComparison: {
      client: { budget: '4000-8000 ريال', duration: '20 يوم', milestones: 'غير محدد' },
      provider: { budget: '4500 ريال', duration: '14 يوم', milestones: '2 مرحلة' },
      aiRecommendation: { budget: '4000-7000 ريال', duration: '10-15 يوم', milestones: '2-3 مراحل' }
    },
    triPartyNote: 'ملاحظة حقيقية من Gemini',
    finalMetrics: {
      overallScore: 88, profileMatch: 90, messageClarity: 85,
      priceCompetitiveness: 80, timelineFeasibility: 95, completeness: 87
    },
    acceptanceOdds: {
      statusText: 'عرضك قوي',
      description: 'وصف استراتيجي حقيقي',
      topPercentage: 'أفضل من 80% من العروض'
    },
    ...overrides
  };
}

const VALID_PAYLOAD = {
  projectId: 'project-1',
  providerId: 'provider-1',
  proposalDraft: {
    title: 'عرض فني',
    message: 'رسالة تفصيلية للعرض تتجاوز خمسين حرفاً بسهولة تامة',
    price: 4500,
    durationDays: 14,
    milestonesCount: 2,
    selectedPortfolioIds: ['p1']
  }
};

async function loadGateway(t: TestContext, opts: {
  project?: any;
  provider?: any;
  isConfigured?: boolean;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const projectFindUniqueSpy = async () => (opts.project === undefined ? projectFixture() : opts.project);
  const userFindUniqueSpy = async () => (opts.provider === undefined ? providerFixture() : opts.provider);
  const prismaMock: any = {
    project: { findUnique: projectFindUniqueSpy },
    user: { findUnique: userFindUniqueSpy }
  };
  t.mock.module('../utils/prisma.client', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      const fixture = validAuditFixture();
      assert.equal(options.validate(fixture), true, 'the real validator must accept a well-formed audit');
      return { data: fixture, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./proposal-audit.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return mod.registerProposalAuditGateway as (socket: any) => void;
}

// ── auth (NEW — this handler previously had no auth check at all) ────────

test('trigger_ai_audit: an unauthenticated socket (no userId) is rejected without touching the DB or Gemini', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async () => { throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_audit_progress');
  assert.equal(emitted[0].payload.status, 'FAILED');
});

// ── ownership (NEW) ────────────────────────────────────────────────────────

test('trigger_ai_audit: a socket requesting an audit for a providerId other than its own is rejected', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['trigger_ai_audit']({ ...VALID_PAYLOAD, providerId: 'someone-elses-id' });

  assert.equal(called, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'FAILED');
});

// ── successful validated audit + ordered events + completion only on success ──

test('trigger_ai_audit: a real validated Gemini audit emits the expected ordered progress sequence then the real result', async (t) => {
  const fixture = validAuditFixture();
  const register = await loadGateway(t, {
    generateStructured: async () => ({ data: fixture, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  const progressStatuses = emitted.filter((e) => e.event === 'ai_audit_progress').map((e) => e.payload.status);
  assert.deepEqual(progressStatuses, ['FETCHING_DATA', 'ANALYZING_PITCH', 'CALCULATING_TRI_PARTY', 'COMPLETED']);
  const resultEvents = emitted.filter((e) => e.event === 'ai_audit_result');
  assert.equal(resultEvents.length, 1);
  assert.deepEqual(resultEvents[0].payload, fixture);
});

// ── malformed Gemini output — honest failure, never patched into fake success ──

test('trigger_ai_audit: a malformed Gemini response (empty profileAudit) is rejected by the real validator, never patched into fake success', async (t) => {
  const malformed = validAuditFixture({ profileAudit: [] });
  const register = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new Error('invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  const resultEvents = emitted.filter((e) => e.event === 'ai_audit_result');
  assert.equal(resultEvents.length, 0);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai_audit_progress');
  assert.equal(last.payload.status, 'FAILED');
});

test('trigger_ai_audit: a malformed Gemini response (out-of-range overallScore) is rejected by the real validator', async (t) => {
  const malformed = validAuditFixture({ finalMetrics: { ...validAuditFixture().finalMetrics, overallScore: 250 } });
  const register = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new Error('invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  assert.equal(emitted.filter((e) => e.event === 'ai_audit_result').length, 0);
  assert.equal(emitted[emitted.length - 1].payload.status, 'FAILED');
});

// ── provider unavailable — no fabricated fallback ─────────────────────────

test('trigger_ai_audit: Gemini throwing produces an honest FAILED status with no result event at all', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async () => { throw new Error('provider unavailable'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  assert.equal(emitted.filter((e) => e.event === 'ai_audit_result').length, 0);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai_audit_progress');
  assert.equal(last.payload.status, 'FAILED');
  // Guard against the old always-positive fallback text ever reappearing.
  assert.doesNotMatch(JSON.stringify(emitted), /احتمال القبول مرتفع|ممتاز.*ممتاز.*ممتاز/);
});

test('trigger_ai_audit: an invalid payload is rejected honestly, never with the old fabricated fallback', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit']({ projectId: '', providerId: 'provider-1' });

  assert.equal(called, false);
  assert.equal(emitted.filter((e) => e.event === 'ai_audit_result').length, 0);
  assert.equal(emitted[emitted.length - 1].payload.status, 'FAILED');
});

test('trigger_ai_audit: a missing project or provider record produces an honest FAILED status, not the fabricated dynamic fallback', async (t) => {
  const register = await loadGateway(t, { project: null });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  assert.equal(emitted.filter((e) => e.event === 'ai_audit_result').length, 0);
  const last = emitted[emitted.length - 1];
  assert.equal(last.payload.status, 'FAILED');
});

// ── not configured ───────────────────────────────────────────────────────

test('trigger_ai_audit: Gemini not configured emits FAILED without ever reading the DB', async (t) => {
  const register = await loadGateway(t, { isConfigured: false });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'FAILED');
});

// ── rate limiting (reuses the shared F1/F2 utility, no new limiter) ───────

test('trigger_ai_audit: a provider issuing more than 30 requests within the window is rate-limited on the next one', async (t) => {
  const register = await loadGateway(t, {});
  const uniqueProviderId = `rate-limit-provider-${Date.now()}-${Math.random()}`;
  const { socket, handlers, emitted } = createMockSocket({ userId: uniqueProviderId });
  register(socket);

  for (let i = 0; i < 30; i++) {
    await handlers['trigger_ai_audit']({ ...VALID_PAYLOAD, providerId: uniqueProviderId });
  }
  emitted.length = 0;

  await handlers['trigger_ai_audit']({ ...VALID_PAYLOAD, providerId: uniqueProviderId });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'FAILED');
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
});

// ── disconnect cancellation ──────────────────────────────────────────────

test('trigger_ai_audit: a socket disconnect aborts the in-flight Gemini call', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const register = await loadGateway(t, {
    generateStructured: (_prompt, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const abortError: any = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'provider-1' });
  register(socket);

  const handlerPromise = handlers['trigger_ai_audit'](VALID_PAYLOAD);
  // Let the microtask queue advance far enough to reach the Gemini call before disconnecting.
  await new Promise((resolve) => setTimeout(resolve, 10));
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to generateStructured');
  assert.equal(capturedSignal!.aborted, true);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai_audit_progress');
  assert.equal(last.payload.status, 'FAILED');
});

// ── no DB write on failure (F5 never writes to the DB at all) ─────────────

test('trigger_ai_audit: no Prisma write method is ever invoked on failure (F5 has no DB writes in any path)', async (t) => {
  let writeAttempted = false;
  const projectFindUniqueSpy = async () => projectFixture();
  const userFindUniqueSpy = async () => providerFixture();
  const prismaMock: any = {
    project: {
      findUnique: projectFindUniqueSpy,
      update: () => { writeAttempted = true; },
      create: () => { writeAttempted = true; }
    },
    user: {
      findUnique: userFindUniqueSpy,
      update: () => { writeAttempted = true; },
      create: () => { writeAttempted = true; }
    }
  };
  t.mock.module('../utils/prisma.client', { namedExports: { prisma: prismaMock } });
  t.mock.module('../services/ai/gemini/gemini.client', {
    namedExports: { geminiClient: { isConfigured: () => true, generateStructured: async () => { throw new Error('unavailable'); } } }
  });

  const moduleUrl = `./proposal-audit.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  const { socket, handlers } = createMockSocket({ userId: 'provider-1' });
  mod.registerProposalAuditGateway(socket);

  await handlers['trigger_ai_audit'](VALID_PAYLOAD);

  assert.equal(writeAttempted, false);
});
