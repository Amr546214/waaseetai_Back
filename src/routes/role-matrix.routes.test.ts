import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Area X (cross-role matrix): the REAL routers + the REAL role middleware are mounted over HTTP; only authentication (reads the test user from a header) is replaced.
// A 403 therefore comes from the real gate. Denied actors must get 403 on every sensitive route; allowed actors must pass the gate (anything but 401/403 — the controller itself
// may then fail on missing DB, which is out of scope: a request that does not answer within 1.5s has certainly passed the gate, because the gate answers immediately).
process.env.OPENAI_API_KEY = 'test-key';
process.env.RATE_LIMIT_ENABLED = 'false'; // the matrix sends hundreds of probes from one IP: a limiter's 429 is not a role decision (limiters have their own tests)

const A = {
  client: { id: 'c1', accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' },
  clientCompany: { id: 'c2', accountType: 'CLIENT_COMPANY', roles: ['CLIENT'], activeRole: 'CLIENT' },
  provider: { id: 'p1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'PROVIDER' },
  providerCompany: { id: 'p2', accountType: 'PROVIDER_COMPANY', roles: ['PROVIDER', 'CLIENT'], activeRole: 'PROVIDER' },
  providerActingAsClient: { id: 'p1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'CLIENT' },
  affiliate: { id: 'm1', accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' },
  affiliateActingAsClient: { id: 'm1', accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'CLIENT' },
  admin: { id: 'a1', accountType: 'ADMIN', roles: ['ADMIN', 'CLIENT'], activeRole: 'ADMIN' },
  superAdmin: { id: 'a2', accountType: 'SUPER_ADMIN', roles: ['SUPER_ADMIN', 'CLIENT'], activeRole: 'SUPER_ADMIN' },
  // dev super-admins have activeRole CLIENT by default: they must never be locked out of admin routes
  superAdminActingAsClient: { id: 'a2', accountType: 'SUPER_ADMIN', roles: ['SUPER_ADMIN', 'CLIENT'], activeRole: 'CLIENT' }
} as const;
type Actor = keyof typeof A;
const ALL = Object.keys(A) as Actor[];
// anyone ACTING as CLIENT is a client (a provider/affiliate/super-admin who switched to the client role may buy and request — that is intended)
const CLIENT_SIDE: Actor[] = ['client', 'clientCompany', 'providerActingAsClient', 'affiliateActingAsClient', 'superAdminActingAsClient'];
const PROVIDER_SIDE: Actor[] = ['provider', 'providerCompany'];
const ADMIN_SIDE: Actor[] = []; // admin routers: see admin-guard.matrix.test.ts

type Group = { name: string; file: string; routes: Array<[string, string]> | 'all'; allowed: Actor[] };
const GROUPS: Group[] = [
  { name: 'client wallet / PayPal deposit', file: './client-finance.routes.ts', routes: 'all', allowed: CLIENT_SIDE },
  { name: 'marketplace cart + checkout', file: './cart-checkout.routes.ts', routes: 'all', allowed: CLIENT_SIDE },
  { name: 'affiliate dashboard (marketer-overview)', file: './marketer-overview.routes.ts', routes: 'all', allowed: ['affiliate'] },
  { name: 'affiliate profile (marketer/profile)', file: './marketer-profile.routes.ts', routes: 'all', allowed: ['affiliate'] },
  // The admin routers are NOT in this matrix any more: access to them comes from permissions read in the database (an ADMIN / SUPER_ADMIN account type grants nothing), which is
  // exercised with real roles in admin-guard.matrix.test.ts and admin-team.pg.test.ts.
  { name: 'provider AI assistant', file: './ai-assistant.routes.ts', routes: 'all', allowed: PROVIDER_SIDE },
  { name: 'provider services CRUD', file: './marketplace-service.routes.ts', routes: 'all', allowed: PROVIDER_SIDE },
  { name: 'provider company team (company only)', file: './company-team.routes.ts', routes: 'all', allowed: ['providerCompany'] },
  { name: 'client company team (company only)', file: './client-company-team.routes.ts', routes: 'all', allowed: ['clientCompany'] },
  { name: 'provider special offers', file: './provider-special-offer.routes.ts', routes: 'all', allowed: PROVIDER_SIDE },
  { name: 'provider marketing center', file: './provider-marketing-center.routes.ts', routes: 'all', allowed: PROVIDER_SIDE },
  { name: 'provider finance / offers / disputes / coupons / amendments', file: './provider.routes.ts', allowed: PROVIDER_SIDE, routes: [['GET', '/finance/invoices'], ['GET', '/finance/sales'], ['POST', '/finance/withdrawals'], ['GET', '/reports'], ['GET', '/coupons'], ['POST', '/coupons'], ['GET', '/disputes'], ['POST', '/offers/x/counter'], ['POST', '/offers/x/withdraw'], ['GET', '/explore-requests'], ['POST', '/offers/x/sign'], ['POST', '/projects/x/amendments']] },
  { name: 'client requests (create, counter-offer, AI suggest)', file: './client-requests.routes.ts', allowed: CLIENT_SIDE, routes: [['POST', '/'], ['POST', '/ai-suggest'], ['POST', '/specialty-recommendations'], ['GET', '/x/offers/x/counter'], ['POST', '/x/offers/x/counter/accept'], ['POST', '/x/offers/x/counter/decline'], ['POST', '/x/offers/select'], ['GET', '/x/contract'], ['POST', '/x/contract/sign'], ['POST', '/x/escrow/deposit'], ['POST', '/x/disputes'], ['POST', '/x/rate'], ['POST', '/x/stages/x/review']] },
  { name: 'create project (client) / submit proposal (provider)', file: './project.routes.ts', allowed: [], routes: [] },
];
// Decision: a SUPER_ADMIN whose activeRole is CLIENT (the dev default) may buy / request — they ARE acting as a client. A SUPER_ADMIN acting as SUPER_ADMIN (or any admin) may not.
// project.routes is split below because one router serves two sides.

// deliberately public routes mounted before a router's gate (public marketer card)
// approval / spend-cap routes are additionally PROVIDER_COMPANY-only (individual accounts never reach them)
const PROVIDER_COMPANY_ONLY = ['/x/approval', '/spend-cap', '/coupons/x/approval'];
// hard-deleting a user is SUPER_ADMIN-only (plain ADMIN is denied)
const SUPER_ADMIN_ONLY = ['./admin-users.routes.ts DELETE /x', './admin-disputes.routes.ts POST /x/resolve-financial'];
const PUBLIC_BY_DESIGN = ['/public/x'];

function listRoutes(router: any): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const l of router.stack) if (l.route && typeof l.route.path === 'string') for (const m of Object.keys(l.route.methods)) out.push([m.toUpperCase(), l.route.path.replace(/:[A-Za-z]+/g, 'x')]);
  return out;
}

test('cross-role matrix: every sensitive router answers 403 to the wrong acting role and passes the right one; no token is 401', async (t: TestContext) => {
  // Hermetic and explicit (no reliance on a missing database or a hanging request):
  //  - the database module is replaced by a stub that THROWS on any use, so a gate or handler that silently reads the database answers 500 and fails the matrix loudly;
  //  - the DB-backed provider-approval state is replaced by an APPROVED provider (the unapproved case has its own test: provider-access.gate.test.ts);
  //  - the final handler of every route is replaced by a known stub that answers 200 {reached:'handler'}, so "passed the gate" means "got that exact answer", never "did not answer".
  const dbTouched = () => { throw new Error('database touched in the role matrix'); };
  const deadModel: any = new Proxy(function () { /* callable */ }, { get: () => dbTouched, apply: dbTouched });
  t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: (_t, k) => (k === '$transaction' || k === '$queryRaw' || k === '$connect' ? dbTouched : deadModel) }) } });
  t.mock.module('../services/provider-access-state.service', { namedExports: { providerAccessStateService: { get: async () => ({ canAccessDashboard: true }) }, DASHBOARD_LOCKED_MESSAGE: 'locked' } });
  const real: any = await import('../middlewares/auth.middleware');
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    ...real,
    authenticate: (req: any, res: any, next: any) => { const h = req.headers['x-test-user']; if (!h) return res.status(401).json({ success: false, message: 'unauth' }); req.user = JSON.parse(String(h)); next(); },
    optionalAuthenticate: (req: any, _res: any, next: any) => { const h = req.headers['x-test-user']; if (h) req.user = JSON.parse(String(h)); next(); },
    requireActiveUser: (_req: any, _res: any, next: any) => next()
  } });

  const servers: any[] = [];
  t.after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
  const serve = async (file: string) => {
    const router = (await import(`${file}?m=${Date.now()}-${Math.random()}`)).default;
    // every route keeps ALL its middleware (gates, validators); only the last handler (the controller) is replaced by the known stub
    for (const l of router.stack) if (l.route && l.route.stack.length) l.route.stack[l.route.stack.length - 1].handle = (_req: any, res: any) => res.status(200).json({ reached: 'handler' });
    const app = express(); app.use(express.json()); app.use('/', router);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
    const server = app.listen(0); servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, actor?: Actor) => {
      try {
        const r = await fetch(base + path, { method, signal: AbortSignal.timeout(1500), headers: { 'content-type': 'application/json', ...(actor ? { 'x-test-user': JSON.stringify(A[actor]) } : {}) }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
        const text = await r.text(); if (r.status === 200) return text.includes('"reached":"handler"') ? 200 : -200; // 200 only counts when it is the stub's own answer
        return r.status === 400 || r.status === 422 ? (JSON.parse(text || '{}').success === false ? 400 : -400) : r.status; // 400 = a request validator that runs AFTER the role gate (an empty body); anything else is the gate / a failure
      } catch { return 0; } // no answer is a FAILURE here (0 never equals the expected 200 / 401 / 403)
    };
    return { router, call };
  };

  const checks: Array<{ name: string; file: string; routes: Array<[string, string]> | 'all'; allowed: Actor[] }> = GROUPS.filter(g => g.name !== 'create project (client) / submit proposal (provider)');
  checks.push(
    { name: 'create project (client only)', file: './project.routes.ts', routes: [['POST', '/']], allowed: CLIENT_SIDE },
    { name: 'submit proposal (provider / affiliate acting)', file: './project.routes.ts', routes: [['POST', '/x/proposals']], allowed: [...PROVIDER_SIDE, 'affiliate'] },
    { name: 'proposal AI suggest (provider)', file: './proposal.routes.ts', routes: [['POST', '/ai-suggest']], allowed: PROVIDER_SIDE }
  );

  const outcome = { handler: 0, validation: 0 };
  for (const g of checks) {
    const { router, call } = await serve(g.file);
    const routes = (g.routes === 'all' ? listRoutes(router) : g.routes).filter(([, p]) => !PUBLIC_BY_DESIGN.includes(p));
    assert.ok(routes.length > 0, `${g.name}: routes found`);
    if (g.routes !== 'all') { const have = listRoutes(router).map(r => r.join(' ')); for (const [m, p] of g.routes) assert.ok(have.includes(`${m} ${p}`), `${g.name}: ${m} ${p} is registered (have: ${have.join(', ')})`); }
    for (const [m, p] of routes) {
      assert.equal(await call(m, p), 401, `${g.name} ${m} ${p}: no token must be 401`);
      for (const actor of ALL) {
        const s = await call(m, p, actor);
        const denyAdmin = SUPER_ADMIN_ONLY.includes(`${g.file} ${m} ${p}`) && actor === 'admin';
        if (g.allowed.includes(actor) && !denyAdmin && !(PROVIDER_COMPANY_ONLY.includes(p) && actor !== 'providerCompany')) { assert.ok(s === 200 || s === 400, `${g.name} ${m} ${p}: ${actor} should pass the role gate and get the stub's 200 or a request-validation 400, got ${s}`); outcome[s === 200 ? 'handler' : 'validation']++; }
        else assert.equal(s, 403, `${g.name} ${m} ${p}: ${actor} must be denied`);
      }
    }
  }
  console.log(`role-matrix outcome: ${outcome.handler} allowed probes reached the stub handler, ${outcome.validation} stopped at request validation after the gate`);
  assert.ok(outcome.handler > 0, 'some allowed probes must reach the handler stub');
});

test('authorizeAdminActing: admin accounts always pass (even acting as CLIENT), others only when ACTING as admin', async () => {
  const { authorizeAdminActing } = await import('../middlewares/auth.middleware');
  const run = (user: any) => { let err: any; authorizeAdminActing({ user } as any, {} as any, (e?: any) => { err = e; }); return err; };
  assert.equal(run(A.superAdminActingAsClient), undefined);
  assert.equal(run(A.admin), undefined);
  assert.equal(run({ accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'ADMIN' }), undefined);
  for (const a of ['client', 'provider', 'affiliate', 'providerActingAsClient'] as Actor[]) assert.equal(run(A[a]).statusCode, 403, a);
  // a user who merely holds ADMIN inside `roles` while acting as CLIENT/PROVIDER is not admitted by this helper
  assert.equal(run({ accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT', 'ADMIN'], activeRole: 'PROVIDER' }).statusCode, 403);
  assert.equal(authorizeAdminActing({} as any, {} as any, (e?: any) => { assert.equal(e.statusCode, 401); }), undefined);
});
