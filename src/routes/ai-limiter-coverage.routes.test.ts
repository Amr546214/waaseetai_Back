import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Implementation Batch 6 — aiLimiter coverage gap fixes. Each of these 5
// routes triggers a real geminiClient call (traced from scratch, not taken
// on the audit's word alone — see the batch report) but was missing
// aiLimiter while sibling AI routes in the same file already had it.
// Deterministic routes are deliberately NOT touched or asserted here.

function readRoute(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

test('proposal.routes.ts: POST /ai-suggest (ai-proposal.service.ts) carries aiLimiter', () => {
  const source = readRoute('proposal.routes.ts');
  assert.ok(source.includes("router.post(\n  '/ai-suggest',\n  authenticate,\n  aiLimiter,"));
});

test('project.routes.ts: POST /:id/proposals (createProposal -> evaluateAndSuggestProposal) carries aiLimiter', () => {
  const source = readRoute('project.routes.ts');
  const start = source.indexOf("router.post(\n  '/:id/proposals',");
  assert.notEqual(start, -1);
  const registration = source.slice(start, source.indexOf(');', start));
  assert.match(registration, /aiLimiter/);
});

test('provider.routes.ts: GET /statistics (getAiMatchingProjects -> aiMatchingEngineService) carries aiLimiter', () => {
  const source = readRoute('provider.routes.ts');
  const start = source.indexOf("router.get(\n  '/statistics',");
  assert.notEqual(start, -1);
  const registration = source.slice(start, source.indexOf(');', start));
  assert.match(registration, /aiLimiter/);
});

test('provider-profile.routes.ts: both /public/:providerId and self-preview /public carry aiLimiter', () => {
  const source = readRoute('provider-profile.routes.ts');
  assert.ok(source.includes("router.get('/public/:providerId', aiLimiter, providerProfileController.getPublicProfile);"));
  assert.ok(source.includes("router.get('/public', requireProvider, aiLimiter, providerProfileController.getPublicProfile);"));
});

test('deterministic sibling routes were left untouched (no aiLimiter added where no Gemini call exists)', () => {
  const clientProfileSource = readRoute('client-profile.routes.ts');
  const clientRegistration = clientProfileSource.split('\n').find(l => l.includes("router.get('/public/:id'")) || '';
  assert.ok(clientRegistration.includes('apiLimiter'));
  assert.doesNotMatch(clientRegistration, /aiLimiter/);

  const marketerSource = readRoute('marketer-profile.routes.ts');
  const marketerRegistration = marketerSource.split('\n').find(l => l.includes("router.get('/public/:id'")) || '';
  assert.doesNotMatch(marketerRegistration, /aiLimiter/);
});

// Implementation Batch 7 — ai-assistant.routes.ts (deep project-fit
// analysis, analyzeProjectForProvider -> geminiClient.generateStructured)
// was calling Gemini with only `authenticate`: no aiLimiter, no
// requireActiveUser, no role restriction. The only real callers are the
// provider-only Explore Requests / Apply-to-Request pages, so the fix adds
// the same providerOnly + requireActiveUser + aiLimiter chain every other
// provider-only Gemini route in provider.routes.ts already carries.
test('ai-assistant.routes.ts: /analyze-project (GET and POST) is providerOnly, requireActiveUser, and carries aiLimiter', () => {
  const source = readRoute('ai-assistant.routes.ts');
  assert.match(source, /router\.use\(authenticate,\s*requireActiveUser,\s*providerOnly,\s*aiLimiter\)/);
  assert.match(source, /providerOnly = authorize\(AccountType\.PROVIDER_INDIVIDUAL,\s*AccountType\.PROVIDER_COMPANY\)/);
  assert.match(source, /router\.get\('\/analyze-project\/:projectId'/);
  assert.match(source, /router\.post\('\/analyze-project'/);
});

// Implementation Batch 8 — the standalone duplicate `GET /ai-matching-
// projects` route (ai-matching.routes.ts/ai-matching.controller.ts) has
// been removed: confirmed zero real frontend callers (only a dead,
// never-invoked provider-api.service.ts method pointed at it) and confirmed
// to call the exact same aiMatchingEngineService.getTop3MatchingProjects()
// already live and wired through GET /provider/statistics. This proves the
// dead route/controller files are gone and the live /statistics path (with
// its own aiLimiter, asserted above) is untouched.
test('the removed /ai-matching-projects duplicate route/controller files no longer exist', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'ai-matching.routes.ts')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'controllers', 'ai-matching.controller.ts')), false);
});

test('provider.routes.ts: no longer mounts the removed ai-matching.routes.ts, and /statistics still calls the same underlying matching engine unaffected', () => {
  const source = readRoute('provider.routes.ts');
  assert.doesNotMatch(source, /ai-matching\.routes/);
  assert.doesNotMatch(source, /aiMatchingRoutes/);
  // /statistics registration (and its aiLimiter) is asserted in full above —
  // this just proves it is still present after the duplicate route's removal.
  assert.match(source, /router\.get\(\s*'\/statistics',/);
});

// Implementation Batch 8 — advisory-only Gemini project health analysis
// (Contract Monitoring / Project Health / Predictive Delay Risk /
// Predictive Dispute Risk — one real feature). Both the provider-side and
// client-side entry points must carry aiLimiter like every other
// Gemini-triggering HTTP route in this codebase.
test('provider.routes.ts: POST /projects/:id/health carries aiLimiter', () => {
  const source = readRoute('provider.routes.ts');
  const start = source.indexOf("router.post('/projects/:id/health',");
  assert.notEqual(start, -1);
  const registration = source.slice(start, source.indexOf(');', start));
  assert.match(registration, /aiLimiter/);
  assert.match(registration, /requireActiveUser/);
});

test('client-requests.routes.ts: POST /:id/health carries aiLimiter', () => {
  const source = readRoute('client-requests.routes.ts');
  const start = source.indexOf("router.post('/:id/health',");
  assert.notEqual(start, -1);
  const registration = source.slice(start, source.indexOf(');', start));
  assert.match(registration, /aiLimiter/);
  assert.match(registration, /requireActiveUser/);
});
