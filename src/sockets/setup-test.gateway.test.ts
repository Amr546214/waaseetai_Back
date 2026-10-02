import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { SetupTestGateway } from './setup-test.gateway';

// The onboarding setup test is disabled (it is presented as an AI assessment
// and WaseetAI has no per-specialty quiz). It must never generate questions,
// score anything, or touch the database.

function setup() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket: any = {
    id: 's1',
    on: (event: string, h: any) => { handlers[event] = h; },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };
  new SetupTestGateway().register(socket);
  return { handlers, emitted };
}

test('setup_test:init with a valid token emits setup_test:error with AI_FEATURE_UNAVAILABLE, no generating/ready events', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const token = jwt.sign({ userId: 'user-1' }, process.env.JWT_SECRET);
  const { handlers, emitted } = setup();
  await handlers['setup_test:init']({ token });
  assert.deepEqual(emitted.map((e) => e.event), ['setup_test:error']);
  assert.equal(emitted[0].payload.code, 'AI_FEATURE_UNAVAILABLE');
  assert.equal(typeof emitted[0].payload.message, 'string');
});

test('setup_test:init with an invalid token is rejected as an auth error', async () => {
  const { handlers, emitted } = setup();
  await handlers['setup_test:init']({ token: 'bad' });
  assert.equal(emitted[0].event, 'setup_test:error');
  assert.equal(emitted[0].payload.code, undefined);
});

test('question/answer events serve nothing and emit nothing', async () => {
  const { handlers, emitted } = setup();
  await handlers['setup_test:get_question']({ token: 'x' });
  await handlers['setup_test:answer']({ token: 'x', questionId: 'q1', selectedIndex: 1 });
  assert.equal(emitted.length, 0);
});

test('setup-test.gateway has no Gemini reference, no prisma and no static question bank', () => {
  const src = readFileSync(new URL('./setup-test.gateway.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /gemini|prisma|generateStructured|correctOptionIndex/i);
});
