import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isSocketConnectLimited, resetSocketConnectLimiter, SOCKET_CONNECT_MAX, SOCKET_CONNECT_WINDOW_MS } from './socket-connect-rate-limit';

beforeEach(() => resetSocketConnectLimiter());

test('a normal reload burst (ten tabs x five sockets) passes; a reconnect loop is refused; other accounts are unaffected', () => {
  for (let i = 0; i < 50; i++) assert.equal(isSocketConnectLimited('u1', 1000 + i), false);
  for (let i = 50; i < SOCKET_CONNECT_MAX; i++) isSocketConnectLimited('u1', 1000 + i);
  assert.equal(isSocketConnectLimited('u1', 5000), true, 'loop refused');
  assert.equal(isSocketConnectLimited('u2', 5000), false, 'another account is not affected');
});

test('the window slides: after it passes the account can connect again', () => {
  for (let i = 0; i < SOCKET_CONNECT_MAX; i++) isSocketConnectLimited('u1', 1000);
  assert.equal(isSocketConnectLimited('u1', 1001), true);
  assert.equal(isSocketConnectLimited('u1', 1000 + SOCKET_CONNECT_WINDOW_MS + 1), false);
});
