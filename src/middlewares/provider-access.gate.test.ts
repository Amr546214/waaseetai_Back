import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// The approved-provider gate on its own (the role matrix assumes an APPROVED provider and never touches this): the state service is replaced by an explicit answer, so every outcome here is a known response.
process.env.OPENAI_API_KEY = 'test-key'; process.env.RATE_LIMIT_ENABLED = 'false';
const provider = (over: any = {}) => ({ id: 'p1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', ...over });

test('requireApprovedProvider: an unapproved individual provider acting as provider is refused 403 PROVIDER_DASHBOARD_LOCKED; an approved one, a company, a provider acting as client and non-providers pass untouched; no user is 401', async (t: TestContext) => {
  let calls = 0; let approved = false;
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../services/provider-access-state.service', { namedExports: { providerAccessStateService: { get: async () => { calls++; return { canAccessDashboard: approved }; } }, DASHBOARD_LOCKED_MESSAGE: 'locked' } });
  const { requireApprovedProvider } = await import(`./provider-access.middleware?m=${Date.now()}`);
  const run = (user: any) => new Promise<any>(r => requireApprovedProvider({ user } as any, {} as any, (e?: any) => r(e)));
  const denied = await run(provider()); assert.equal(denied.statusCode, 403); assert.equal(denied.code, 'PROVIDER_DASHBOARD_LOCKED'); assert.equal(calls, 1);
  approved = true; assert.equal(await run(provider()), undefined); assert.equal(calls, 2);
  approved = false; const before = calls;
  for (const u of [provider({ accountType: 'PROVIDER_COMPANY' }), provider({ activeRole: 'CLIENT' }), { id: 'c1', accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' }]) assert.equal(await run(u), undefined);
  assert.equal(calls, before, 'those accounts never reach the approval lookup');
  assert.equal((await run(undefined)).statusCode, 401);
});

test('the real assistant router: an UNAPPROVED provider is 403 PROVIDER_DASHBOARD_LOCKED over HTTP, an approved one reaches the known handler (200), a client is 403 by role', async (t: TestContext) => {
  let approved = false;
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../services/provider-access-state.service', { namedExports: { providerAccessStateService: { get: async () => ({ canAccessDashboard: approved }) }, DASHBOARD_LOCKED_MESSAGE: 'locked' } });
  const real: any = await import('./auth.middleware');
  t.mock.module('./auth.middleware', { namedExports: { ...real, authenticate: (req: any, res: any, next: any) => { const h = req.headers['x-test-user']; if (!h) return res.status(401).json({ success: false }); req.user = JSON.parse(String(h)); next(); }, requireActiveUser: (_q: any, _r: any, n: any) => n() } });
  const router = (await import(`../routes/ai-assistant.routes?m=${Date.now()}`)).default;
  for (const l of router.stack) if (l.route && l.route.stack.length) l.route.stack[l.route.stack.length - 1].handle = (_q: any, res: any) => res.status(200).json({ reached: 'handler' });
  const app = express(); app.use(express.json()); app.use('/', router); app.use((err: any, _q: any, res: any, _n: any) => res.status(err.statusCode || 500).json({ success: false, code: err.code }));
  const server = app.listen(0); t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (u?: any) => { const r = await fetch(`${base}/analyze-project/x`, { headers: u ? { 'x-test-user': JSON.stringify(u) } : {} }); return { status: r.status, body: await r.json() }; };
  const locked = await get(provider()); assert.equal(locked.status, 403); assert.equal(locked.body.code, 'PROVIDER_DASHBOARD_LOCKED');
  approved = true; const ok = await get(provider()); assert.equal(ok.status, 200); assert.equal(ok.body.reached, 'handler');
  assert.equal((await get({ id: 'c1', accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' })).status, 403);
  assert.equal((await get()).status, 401);
});
