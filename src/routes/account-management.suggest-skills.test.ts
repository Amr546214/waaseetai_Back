import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A client adding a provider account has no provider profile yet: the add-account wizard gets the same AI skills suggestion (draft context only), rate limited like the provider one.
test('POST /account-management/suggest-skills exists behind authentication and the AI rate limiter', () => {
  const src = readFileSync(join(process.cwd(), 'src/routes/account-management.routes.ts'), 'utf8');
  assert.match(src, /router\.use\(authenticate, requireActiveUser\)/);
  assert.match(src, /router\.post\('\/suggest-skills', aiLimiter, suggestSkillsFromCatalog\)/);
  assert.ok(src.indexOf("router.use(authenticate") < src.indexOf("'/suggest-skills'"), 'registered after the authentication middleware');
});

test('suggestSkillsFromCatalog: only exact names of the caller\'s catalog come back (any letter case), known / invented / duplicate ones are dropped', async t => {
  const calls: any[] = [];
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../services/ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: { suggestSkills: async (p: any) => { calls.push(p); return { suggestedSkills: ['كتابة الإعلان', 'seo', 'مهارة مخترعة', 'كتابة الإعلان', 'التوطين'] }; } } } });
  const { providerProfileService } = await import(`../services/provider-profile.service.ts?fixture=${Date.now()}`);
  const out = await providerProfileService.suggestSkillsFromCatalog('u1', { mainSpecialty: 'كتابة وترجمة', availableSkills: ['كتابة الإعلان', 'SEO', 'التوطين', 'الترجمة العربية'], existingSkills: ['التوطين'] });
  assert.deepEqual(out.suggestedSkills, ['كتابة الإعلان', 'SEO']);
  assert.deepEqual(calls[0].availableSkills, ['كتابة الإعلان', 'SEO', 'التوطين', 'الترجمة العربية']);
  assert.equal(calls[0].specialtyName, 'كتابة وترجمة');
});
