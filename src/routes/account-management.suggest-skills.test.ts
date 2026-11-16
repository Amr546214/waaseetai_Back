import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A client adding a provider account has no provider profile yet: the add-account wizard gets the same AI skills suggestion (draft context only), rate limited like the provider one.
test('POST /account-management/suggest-skills exists behind authentication and the AI rate limiter', () => {
  const src = readFileSync(join(process.cwd(), 'src/routes/account-management.routes.ts'), 'utf8');
  assert.match(src, /router\.use\(authenticate, requireActiveUser\)/);
  assert.match(src, /router\.post\('\/suggest-skills', aiLimiter, suggestSkills\)/);
  assert.ok(src.indexOf("router.use(authenticate") < src.indexOf("'/suggest-skills'"), 'registered after the authentication middleware');
});
