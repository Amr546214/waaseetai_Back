import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Area X scan: the conversation payload must not carry a hard-coded presence flag or a made-up specialty (real presence arrives over the socket as isOnline).
const src = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
test('chat.service formatConversationOutput has no constant `online: true` and no invented specialty fallback', () => {
  assert.doesNotMatch(src, /online:\s*true/);
  assert.doesNotMatch(src, /تطوير وتصميم/);
});
