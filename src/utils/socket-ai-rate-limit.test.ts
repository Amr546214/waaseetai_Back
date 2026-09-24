import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSocketAiRateLimited } from './socket-ai-rate-limit';

test('isSocketAiRateLimited: allows the first 30 requests for a key within the window', () => {
  const key = `user-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 30; i++) {
    assert.equal(isSocketAiRateLimited(key), false, `request ${i + 1} should not be limited`);
  }
});

test('isSocketAiRateLimited: the 31st request within the window is limited', () => {
  const key = `user-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 30; i++) isSocketAiRateLimited(key);
  assert.equal(isSocketAiRateLimited(key), true);
});

test('isSocketAiRateLimited: different keys are tracked independently', () => {
  const keyA = `user-a-${Date.now()}-${Math.random()}`;
  const keyB = `user-b-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 30; i++) isSocketAiRateLimited(keyA);

  assert.equal(isSocketAiRateLimited(keyA), true);
  assert.equal(isSocketAiRateLimited(keyB), false);
});
