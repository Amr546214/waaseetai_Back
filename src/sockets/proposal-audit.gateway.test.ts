import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProposalAuditGateway } from './proposal-audit.gateway';

// Proposal AI audit is disabled until WaseetAI supports it. The gateway keeps
// its auth/payload/ownership checks and answers with the existing frontend
// contract (`ai_audit_progress` status FAILED) plus code AI_FEATURE_UNAVAILABLE.

function setup(userId?: string) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket: any = {
    id: `s-${Math.random()}`,
    userId,
    on: (event: string, h: any) => { handlers[event] = h; },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };
  new ProposalAuditGateway().register(socket);
  return { handlers, emitted };
}

const validPayload = (providerId = 'provider-1') => ({
  projectId: 'project-1',
  providerId,
  proposalDraft: { title: 't', message: 'm', price: 100, durationDays: 5, milestonesCount: 2 }
});

test('trigger_ai_audit: valid request emits FAILED with AI_FEATURE_UNAVAILABLE and never an ai_audit_result', async () => {
  const { handlers, emitted } = setup('provider-1');
  await handlers['trigger_ai_audit'](validPayload());
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_audit_progress');
  assert.equal(emitted[0].payload.status, 'FAILED');
  assert.equal(emitted[0].payload.code, 'AI_FEATURE_UNAVAILABLE');
  assert.match(emitted[0].payload.message, /WaseetAI/);
  assert.ok(!emitted.some((e) => e.event === 'ai_audit_result'));
});

test('trigger_ai_audit: unauthenticated socket is rejected without the unavailable code', async () => {
  const { handlers, emitted } = setup(undefined);
  await handlers['trigger_ai_audit'](validPayload());
  assert.equal(emitted[0].payload.status, 'FAILED');
  assert.equal(emitted[0].payload.code, undefined);
});

test('trigger_ai_audit: invalid payload and foreign providerId are rejected', async () => {
  const a = setup('provider-1');
  await a.handlers['trigger_ai_audit']({ nope: true });
  assert.equal(a.emitted[0].payload.status, 'FAILED');
  assert.equal(a.emitted[0].payload.code, undefined);
  const b = setup('provider-1');
  await b.handlers['trigger_ai_audit'](validPayload('provider-2'));
  assert.equal(b.emitted[0].payload.code, undefined);
});

test('trigger_ai_audit: a provider issuing more than 30 requests within the window is rate-limited on the next one', async () => {
  const providerId = `rate-limit-provider-${Date.now()}-${Math.random()}`;
  const { handlers, emitted } = setup(providerId);
  for (let i = 0; i < 30; i++) await handlers['trigger_ai_audit'](validPayload(providerId));
  assert.ok(emitted.every((e) => e.payload.code === 'AI_FEATURE_UNAVAILABLE'));
  emitted.length = 0;

  await handlers['trigger_ai_audit'](validPayload(providerId));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'FAILED');
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
  assert.equal(emitted[0].payload.code, undefined);
});

test('trigger_ai_audit: rejected requests (unauthenticated / invalid / foreign provider) never consume the rate-limit budget', async () => {
  const providerId = `budget-provider-${Date.now()}-${Math.random()}`;
  const { handlers, emitted } = setup(providerId);
  for (let i = 0; i < 40; i++) await handlers['trigger_ai_audit']({ nope: true });
  for (let i = 0; i < 40; i++) await handlers['trigger_ai_audit'](validPayload('someone-else'));
  emitted.length = 0;
  await handlers['trigger_ai_audit'](validPayload(providerId));
  assert.equal(emitted[0].payload.code, 'AI_FEATURE_UNAVAILABLE');
});

test('proposal-audit.gateway has no Gemini reference and makes no AI/DB call', () => {
  const src = readFileSync(new URL('./proposal-audit.gateway.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /gemini|generateStructured|prisma|waseetAiClient/i);
});
