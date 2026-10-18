import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetServiceTokenBroker, waseetActorRole, runWithWaseetActor, currentWaseetActor } from './waseet-ai.auth';
import type { WaseetAiConfig } from '../../../config/ai/waseet-ai.config';

const config: WaseetAiConfig = { baseUrl: 'https://service.invalid', bearerToken: '', authMode: 'signed',
  clientId: 'platform-test', clientSecret: 's'.repeat(40), environment: 'dev', restTimeoutMs: 30000, streamTimeoutMs: 90000 };
const response = (token: string, expiresIn = 900) => new Response(JSON.stringify({ success: true, data: { token, expiresIn } }), { status: 200 });

test('signed service tokens are cached per actor, role, environment and secret; expiry refreshes', async () => {
  let time = 0; const calls: any[] = [];
  const broker = new WaseetServiceTokenBroker(async (_url, init) => { calls.push(JSON.parse(String(init.body))); return response(`token-${calls.length}`); }, () => time);
  const signal = new AbortController().signal;
  const actor = { userId: 'owner', role: 'client' as const };
  assert.equal(await broker.token(config, actor, signal, 'r1'), 'token-1');
  assert.equal(await broker.token(config, actor, signal, 'r2'), 'token-1');
  await broker.token(config, { ...actor, userId: 'other' }, signal, 'r3');
  await broker.token(config, { ...actor, role: 'provider' }, signal, 'r4');
  await broker.token({ ...config, environment: 'bank' }, actor, signal, 'r5');
  await broker.token({ ...config, clientSecret: 't'.repeat(40) }, actor, signal, 'r6');
  assert.equal(calls.length, 5);
  time = 875_000;
  assert.equal(await broker.token(config, actor, signal, 'r7'), 'token-6');
  assert.deepEqual(calls[0].actor, actor);
});

test('cancelling a token exchange does not cancel a simultaneous request from the same actor', async () => {
  const actor = { userId: 'owner', role: 'client' as const };
  const broker = new WaseetServiceTokenBroker(async (_url, init) => {
    if (init.headers && (init.headers as Record<string, string>)['X-Request-Id'] === 'cancelled') {
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return response('survivor');
  });
  const first = new AbortController();
  const pending = broker.token(config, actor, first.signal, 'cancelled');
  const survivor = broker.token(config, actor, new AbortController().signal, 'survivor');
  first.abort();
  await assert.rejects(pending);
  assert.equal(await survivor, 'survivor');
});

test('invalid signed credentials and token lifetime fail closed', async () => {
  const broker = new WaseetServiceTokenBroker(async () => response('invalid', 901));
  const actor = { userId: 'owner', role: 'client' as const }, signal = new AbortController().signal;
  await assert.rejects(broker.token({ ...config, clientSecret: 'short' }, actor, signal, 'r'));
  await assert.rejects(broker.token(config, actor, signal, 'r'));
});

test('verified active role takes precedence and asynchronous identities never cross users', async () => {
  assert.equal(waseetActorRole('CLIENT', 'PROVIDER_INDIVIDUAL'), 'client');
  assert.equal(waseetActorRole('PROVIDER', 'CLIENT_INDIVIDUAL'), 'provider');
  assert.equal(waseetActorRole('CLIENT', 'ADMIN'), 'admin');
  await Promise.all(['one', 'two'].map(userId => runWithWaseetActor({ userId, role: 'client' }, async () => {
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(currentWaseetActor()?.userId, userId);
  })));
  assert.equal(currentWaseetActor(), undefined);
});
