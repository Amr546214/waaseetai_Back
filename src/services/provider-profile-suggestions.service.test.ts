import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { providerBioSuggestSchema, providerSkillsSuggestSchema } from '../dtos/provider-profile-suggest.dto';

// No real client, DB, notification/socket side effects, or provider calls.
async function load(t: TestContext, opts: { profile?: any; rows?: any[]; output?: any; error?: unknown; catalog?: string[]; review?: any; inspect?: any } = {}) {
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
  if (opts.catalog) t.mock.module('./skills-catalog.service', { namedExports: { getCatalogForCategoryParam: async () => ({ category: 'web', skills: opts.catalog }) } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('../config/logger', { namedExports: { logger: {
    warn: (...a: any[]) => logs.push(a), debug: () => {}, info: () => {}, error: () => {}
  } } });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: {
    suggestBio: async (body: any) => {
      sent.push(body);
      if (opts.error !== undefined) throw opts.error;
      return opts.output ?? { suggestedBio: 'مطور مواقع متخصص في تطوير المواقع باستخدام HTML.' };
    },
    inspectSelfie: async (body: any) => { sent.push(body); if (opts.error !== undefined) throw opts.error; return opts.inspect; },
    inspectCertificate: async (body: any) => { sent.push(body); if (opts.error !== undefined) throw opts.error; return opts.inspect; },
    reviewAccreditation: async (body: any) => {
      sent.push(body);
      if (opts.error !== undefined) throw opts.error;
      return opts.review;
    },
    suggestSkills: async (body: any) => {
      sent.push(body);
      if (opts.error !== undefined) throw opts.error;
      return opts.output ?? { suggestedSkills: ['css', 'TypeScript'] };
    }
  } } });
  const { providerProfileService: service } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service, reads, sent, logs, writes: () => writes };
}

test('bio: sends providerId = authenticated user id and context from DB; returns suggestedBio with zero writes', async t => {
  const x = await load(t);
  const result = await x.service.suggestBio('p', { jobTitle: 'مطور' });
  assert.equal(result.suggestedBio, 'مطور مواقع متخصص في تطوير المواقع باستخدام HTML.');
  assert.equal(x.reads.length, 1);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].providerId, 'p');
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

test('skills: the category CATALOG is the source of names (the Skill table only holds names somebody already saved), so an almost empty table still suggests', async t => {
  const x = await load(t, { rows: [{ name: 'Flutter' }], catalog: ['Express', 'Node.js', 'React'], output: { suggestedSkills: ['node.js', 'Express', 'Flutter'] } });
  const result = await x.service.suggestSkills('p', { subSpecialties: ['تطوير الواجهات الخلفية'] } as any);
  assert.deepEqual(result, { suggestedSkills: ['Node.js', 'Express'] });
  assert.deepEqual(x.sent[0].availableSkills, ['Express', 'Node.js', 'React']);
  assert.equal(x.writes(), 0);
});

const PDF = 'data:application/pdf;base64,' + 'A'.repeat(100);
const review = (score: number | null, inspected = true) => ({ status: 'MANUAL_REVIEW', aiScore: score, inspected, feedback: { summary: 'ملخص الذكاء الاصطناعي. الاعتماد النهائي للمراجعة البشرية؛ هذا تقييم استشاري.', recommendations: ['أضف تفاصيل'] }, evaluation: { aiScore: score } });

const input = (kind: 'MODEL' | 'PROOF', file = PDF, mimeType = 'application/pdf') => ({ kind, specialtyName: 'برمجة', mimeType, file });

test('portfolio file check: a work sample at or above the bar passes (the human-review boilerplate is dropped from the reason)', async t => {
  const x = await load(t, { review: review(85) });
  const ok = await x.service.checkPortfolioFile('p', input('MODEL'));
  assert.equal(ok.verdict, 'PASS'); assert.equal(ok.score, 85); assert.ok(!ok.summaryAr.includes('الاعتماد النهائي'));
  assert.equal(x.sent[0].specialtyName, 'برمجة'); assert.deepEqual(x.sent[0].attachments, [PDF]);
});

test('portfolio file check: below the bar the work sample fails with the AI reason and advice', async t => {
  const x = await load(t, { review: review(49) });
  const bad = await x.service.checkPortfolioFile('p', input('MODEL'));
  assert.equal(bad.verdict, 'FAIL'); assert.deepEqual(bad.recommendationsAr, ['أضف تفاصيل']);
});

test('portfolio file check: a proof of ownership passes at a score where a work sample would fail', async t => {
  const x = await load(t, { review: review(45) });
  assert.equal((await x.service.checkPortfolioFile('p', input('PROOF'))).verdict, 'PASS');
});

test('portfolio file check: the same score fails as a work sample', async t => {
  const x = await load(t, { review: review(45) });
  assert.equal((await x.service.checkPortfolioFile('p', input('MODEL'))).verdict, 'FAIL');
});

test('portfolio file check: a file the AI could not read is UNVERIFIED, never a refusal', async t => {
  const x = await load(t, { review: review(null, false) });
  assert.equal((await x.service.checkPortfolioFile('p', input('MODEL', PDF, 'image/png'))).verdict, 'UNVERIFIED');
});

test('portfolio file check: a file over the AI limit is UNVERIFIED and is not sent', async t => {
  const x = await load(t, { review: review(90) });
  const big = await x.service.checkPortfolioFile('p', input('MODEL', 'data:application/pdf;base64,' + 'A'.repeat(3_300_000)));
  assert.equal(big.verdict, 'UNVERIFIED'); assert.equal(x.sent.length, 0);
});

test('portfolio file check: an AI service error is UNVERIFIED (the human review decides)', async t => {
  const x = await load(t, { error: new Error('down') });
  assert.equal((await x.service.checkPortfolioFile('p', input('MODEL'))).verdict, 'UNVERIFIED');
});

test('selfie check: the photo goes to the AI as the provider and the advisory answer comes back unchanged', async t => {
  const answer = { status: 'NEEDS_ATTENTION', containsPerson: true, summaryAr: 'ملاحظة', warningsAr: ['الوجه غير واضح'], faceMatch: 'NOT_CHECKED', liveness: 'NOT_CHECKED', advisoryOnly: true };
  const x = await load(t, { inspect: answer });
  const out = await x.service.verifySelfie('p', { image: 'data:image/png;base64,' + 'A'.repeat(40), imageMimeType: 'image/png' });
  assert.deepEqual(out, answer); assert.equal(x.sent[0].requireDocument, true); assert.equal(x.sent[0].imageMimeType, 'image/png');
});

test('selfie check: an AI failure is a 503 that tells the person the human review decides', async t => {
  const x = await load(t, { error: new Error('down') });
  await assert.rejects(() => x.service.verifySelfie('p', { image: 'data:image/png;base64,' + 'A'.repeat(40), imageMimeType: 'image/png' }), (e: any) => e.statusCode === 503 && /المراجعة البشرية/.test(e.message));
});

test('certificate check: the specialty travels with the file and the answer comes back unchanged', async t => {
  const answer = { status: 'CLEAR_VALID', isCertificate: true, readability: 'CLEAR', detectedTitle: 'شهادة', issuer: null, relevanceToSpecialty: 'RELATED', summaryAr: '', warningsAr: [], advisoryOnly: true };
  const x = await load(t, { inspect: answer });
  const out = await x.service.verifyCertificate('p', { image: 'data:application/pdf;base64,' + 'A'.repeat(40), imageMimeType: 'application/pdf', specialtyName: 'برمجة' });
  assert.deepEqual(out, answer); assert.equal(x.sent[0].specialtyName, 'برمجة');
});

test('certificate check: an AI failure is a 503 (never a refusal)', async t => {
  const x = await load(t, { error: new Error('down') });
  await assert.rejects(() => x.service.verifyCertificate('p', { image: 'data:image/png;base64,' + 'A'.repeat(40), imageMimeType: 'image/png' }), (e: any) => e.statusCode === 503);
});
