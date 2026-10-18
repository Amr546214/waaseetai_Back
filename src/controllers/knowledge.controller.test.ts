import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppError } from '../utils/app-error';
import { errorFromHttpStatus } from '../services/ai/waseet-ai/waseet-ai.errors';

function request(query: Record<string, unknown>, user?: unknown): any {
  return Object.assign(new EventEmitter(), { query, user, params: {}, aborted: false });
}
function response(): any {
  return Object.assign(new EventEmitter(), { writableEnded: false, output: undefined,
    json(data: unknown) { this.output = data; this.writableEnded = true; } });
}

test('knowledge controller uses verified account identity and cannot elevate an audience from query or user.role', async t => {
  const seen: any[] = [];
  t.mock.module('../services/ai-features/knowledge-retrieval.service', { namedExports: {
    knowledgeRetrievalService: { searchWithSource: async (_: string, opts: unknown) => {
      seen.push(opts); return { documents: [], source: 'WASEET_KNOWLEDGE', retrievalMode: 'lexical' };
    } },
  } });
  const { searchKnowledge } = await import(`./knowledge.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const client = request({ q: 'policy', audience: 'admin' }, { id: 'client-1', status: 'ACTIVE', activeRole: 'CLIENT', accountType: 'CLIENT', role: 'admin' });
  const guest = request({ q: 'policy', audience: 'provider' }, { id: 'provider-1', status: 'SUSPENDED', activeRole: 'PROVIDER' });
  for (const req of [client, guest]) {
    const res = response();
    await searchKnowledge(req, res, err => { throw err; });
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
  assert.deepEqual(seen[0].actor, { userId: 'client-1', role: 'client' });
  assert.equal(seen[0].audience, 'all');
  assert.equal(seen[1].actor, undefined);
  assert.equal(seen[1].audience, 'all');
});

test('knowledge controller rejects draft, private and other-owner documents on direct lookup', async t => {
  const doc = { documentId: 'doc', status: 'APPROVED', approvedBy: 'admin', approvedAt: '2026-01-01', audience: 'all' };
  let current: any = doc;
  t.mock.module('../services/ai-features/knowledge-retrieval.service', { namedExports: {
    knowledgeRetrievalService: { getById: () => current },
  } });
  const { getKnowledgeDoc } = await import(`./knowledge.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const req = request({}, { id: 'client-1', status: 'ACTIVE', activeRole: 'CLIENT' }); req.params.id = 'doc';
  for (const change of [{ status: 'DRAFT' }, { approvedAt: undefined }, { audience: 'admin' }, { ownerId: 'another-user' }]) {
    current = { ...doc, ...change };
    const res = response(); let error: any;
    getKnowledgeDoc(req, res, value => { error = value; });
    assert.equal(error.statusCode, 403);
    assert.equal(res.output, undefined);
  }
  current = { ...doc, ownerId: 'client-1' };
  const res = response(); getKnowledgeDoc(req, res, err => { throw err; });
  assert.equal(res.output.success, true);
});

test('knowledge controller preserves upstream permission failure without publishing fallback content', async t => {
  t.mock.module('../services/ai-features/knowledge-retrieval.service', { namedExports: {
    knowledgeRetrievalService: { searchWithSource: async () => { throw errorFromHttpStatus(403); } },
  } });
  const { searchKnowledge } = await import(`./knowledge.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const res = response(); let error: any;
  await searchKnowledge(request({ q: 'policy' }), res, value => { error = value; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 403);
  assert.equal(res.output, undefined);
});

test('knowledge controller cancels upstream work when the HTTP connection closes', async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  t.mock.module('../services/ai-features/knowledge-retrieval.service', { namedExports: {
    knowledgeRetrievalService: { searchWithSource: async (_: string, opts: any) => {
      signal = opts.signal; started();
      return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    } },
  } });
  const { searchKnowledge } = await import(`./knowledge.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const req = request({ q: 'policy' }); const res = response(); let forwarded = false;
  const pending = searchKnowledge(req, res, () => { forwarded = true; });
  await ready; res.emit('close'); await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(res.output, undefined);
  assert.equal(forwarded, false);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});
