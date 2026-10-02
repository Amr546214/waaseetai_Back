import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { providerBioSuggestSchema, providerSkillsSuggestSchema } from '../dtos/provider-profile-suggest.dto';

// No real client, DB, notification/socket side effects, or provider calls.
async function load(t: TestContext, opts: { profile?: any; rows?: any[]; output?: any; error?: unknown } = {}) {
  const reads: any[] = [];
  const sent: any[] = [];
  const logs: any[][] = [];
  let writes = 0;
  const denyWrite = () => { writes++; throw new Error('Suggestion attempted DB write'); };
  const table = (o: any) => new Proxy(o, { get: (obj, key) => key in obj ? obj[key] : denyWrite });
  const prisma = new Proxy({
    providerProfile: table({ findUnique: async (args: any) => {
      reads.push(args);
      return opts.profile === undefined ? { headline: 'مطور مواقع', industry: 'مهنة محفوظة', mainSpecialty: 'web', skills: [{ name: 'HTML' }] } : opts.profile;
    } }),
    category: table({ findFirst: async () => ({ nameAr: 'تطوير المواقع' }) }),
    skill: table({ findMany: async () => opts.rows ?? [{ name: 'HTML' }, { name: 'CSS' }, { name: 'TypeScript' }] })
  }, { get: (obj: any, key) => key in obj ? obj[key] : denyWrite });
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('../config/logger', { namedExports: { logger: {
    warn: (...a: any[]) => logs.push(a), debug: () => {}, info: () => {}, error: () => {}
  } } });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: {
    suggestSkills: async (body: any) => {
      sent.push(body);
      if (opts.error !== undefined) throw opts.error;
      return opts.output ?? { suggestedSkills: ['css', 'TypeScript'] };
    }
  } } });
  const { providerProfileService: service } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service, reads, sent, logs, writes: () => writes };
}

test('bio: disabled with AI_FEATURE_UNAVAILABLE 503 and a specific Arabic message; no DB read, no upstream call', async t => {
  const x = await load(t);
  await assert.rejects(x.service.suggestBio('p', { jobTitle: 'مطور' }), (e: any) =>
    e.statusCode === 503 && e.code === 'AI_FEATURE_UNAVAILABLE' && /النبذة التعريفية/.test(e.message));
  assert.equal(x.reads.length, 0);
  assert.equal(x.sent.length, 0);
  assert.equal(x.writes(), 0);
});

test('skills: sends providerId = authenticated user id and specialtyName from DB (category name); forged body ignored', async t => {
  const x = await load(t);
  const result = await x.service.suggestSkills('authenticated-provider', { mainSpecialty: 'FORGED' } as any);
  assert.deepEqual(x.sent, [{ providerId: 'authenticated-provider', specialtyName: 'تطوير المواقع', existingSkills: ['HTML'] }]);
  assert.deepEqual(x.reads[0].where, { userId: 'authenticated-provider' });
  assert.deepEqual(result, { suggestedSkills: ['CSS', 'TypeScript'] });
  assert.equal(x.writes(), 0);
});

test('skills: falls back to job title when no specialty; rejects with 400 when neither exists', async t => {
  const x = await load(t, { profile: { headline: 'مصمم', industry: null, mainSpecialty: null, skills: [] } });
  await x.service.suggestSkills('p', {});
  assert.equal(x.sent[0].specialtyName, 'مصمم');
});

test('skills: rejects with 400 when neither specialty nor title exists, no upstream call', async t => {
  const y = await load(t, { profile: null });
  await assert.rejects(y.service.suggestSkills('p', {}), (e: any) => e.statusCode === 400);
  assert.equal(y.sent.length, 0);
});

test('skills: existing skills, duplicates, non-taxonomy and over-cap results are filtered; canonical names returned', async t => {
  const names = Array.from({ length: 12 }, (_, i) => `Skill${i}`);
  const x = await load(t, { rows: [{ name: 'HTML' }, ...names.map(name => ({ name }))],
    output: { suggestedSkills: ['html', 'skill0', 'SKILL0', 'Invented', ...names.slice(1)] } });
  const out = (await x.service.suggestSkills('p', {})).suggestedSkills;
  assert.equal(out[0], 'Skill0');
  assert.equal(out.length, 8);
  assert.ok(!out.includes('HTML') && !out.includes('Invented'));
});

test('skills: empty taxonomy -> empty result without upstream call', async t => {
  const x = await load(t, { rows: [] });
  assert.deepEqual(await x.service.suggestSkills('p', {}), { suggestedSkills: [] });
  assert.equal(x.sent.length, 0);
});

test('skills: upstream failure gives honest 503, no fabricated skills, zero writes, only a sanitized code logged', async t => {
  const err = Object.assign(new Error('boom apiKey=SECRET'), { code: 'UPSTREAM_UNAVAILABLE' });
  const x = await load(t, { error: err });
  await assert.rejects(x.service.suggestSkills('p', {}), (e: any) => e.statusCode === 503 && /تعذر إنشاء اقتراح/.test(e.message) && !('suggestedSkills' in e));
  assert.equal(x.writes(), 0);
  const text = x.logs.map(l => l.map(String).join(' ')).join('\n');
  assert.match(text, /UPSTREAM_UNAVAILABLE/);
  assert.equal(text.includes('SECRET'), false);
});

test('skills: whitespace/case-insensitive canonical mapping, over-length taxonomy names are never suggested', async t => {
  const rows = ['HTML', 'CSS', 'a'.repeat(41)].map(name => ({ name }));
  const x = await load(t, { rows, output: { suggestedSkills: [' css ', 'a'.repeat(41)] } });
  assert.deepEqual(await x.service.suggestSkills('p', {}), { suggestedSkills: ['CSS'] });
  assert.equal(x.writes(), 0);
});

test('skills: accepts eight real skills at the length boundary', async t => {
  const names = Array.from({ length: 8 }, (_, i) => 'a'.repeat(39) + String(i));
  const x = await load(t, { rows: names.map(name => ({ name })), output: { suggestedSkills: names } });
  assert.deepEqual((await x.service.suggestSkills('p', {})).suggestedSkills, names);
});

test('skills: relevant subset may be empty without fabricated fallback', async t => {
  const x = await load(t, { output: { suggestedSkills: [] } });
  assert.deepEqual(await x.service.suggestSkills('p', {}), { suggestedSkills: [] });
  assert.equal(x.writes(), 0);
});

for (const output of [{}, { suggestedSkills: [{ id: 'x', name: 'CSS' }] }]) {
  test(`skills: a malformed upstream payload ${JSON.stringify(output)} gives the honest 503, no fabricated skills, zero writes`, async t => {
    const x = await load(t, { output });
    await assert.rejects(x.service.suggestSkills('p', {}), (e: any) => e.statusCode === 503 && !('suggestedSkills' in e));
    assert.equal(x.writes(), 0);
  });
}

test('DTOs reject identity injection, unsupported facts, invalid types and oversized input', () => {
  for (const schema of [providerBioSuggestSchema, providerSkillsSuggestSchema]) {
    assert.equal(schema.safeParse({}).success, true);
    for (const value of [{ userId: 'victim' }, { currentBio: 'fabricated achievements' }, { yearsOfExperience: 99 }, { jobTitle: 'x'.repeat(121) },
      { experienceRange: '99 years' }, { existingSkills: [''] }, { existingSkills: ['x'.repeat(41)] }, { existingSkills: Array(31).fill('CSS') }]) {
      assert.equal(schema.safeParse(value).success, false);
    }
  }
});

test('static: touched provider-profile sources contain no direct Gemini usage', () => {
  const dir = path.resolve(__dirname, '..');
  for (const f of ['services/provider-profile.service.ts', 'controllers/provider-profile.controller.ts', 'routes/provider-profile.routes.ts']) {
    assert.doesNotMatch(readFileSync(path.join(dir, f), 'utf8'), /gemini\.client|geminiClient|generateStructured|generateStream/, f);
  }
});
