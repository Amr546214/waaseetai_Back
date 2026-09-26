import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { providerBioSuggestSchema, providerSkillsSuggestSchema } from '../dtos/provider-profile-suggest.dto';

// No real client, DB, notification/socket side effects, or provider calls.
async function load(t: TestContext, opts: { profile?: any; rows?: any[]; output?: any; unavailable?: boolean } = {}) {
  const reads: any[] = [];
  const prompts: { prompt: string; options: any }[] = [];
  let writes = 0;
  const denyWrite = () => { writes++; throw new Error('Suggestion attempted DB write'); };
  const table = (reads: any) => new Proxy(reads, { get: (obj, key) => key in obj ? obj[key] : denyWrite });
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
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: {
    generateStructured: async (prompt: string, options: any) => {
      prompts.push({ prompt, options });
      if (opts.unavailable) throw new Error('Gemini unavailable');
      const data = opts.output ?? { suggestedBio: 'أقدم خدمات تطوير المواقع باستخدام المهارات المذكورة.' };
      if (!options.validate(data)) throw new Error('INVALID_RESPONSE');
      return { data };
    }
  } } });
  const { providerProfileService: service } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service, reads, prompts, writes: () => writes };
}

test('bio: server reads authenticated identity, DB context wins, only allowlisted self-reported fields reach Gemini; zero writes', async t => {
  const x = await load(t);
  const result = await x.service.suggestBio('authenticated-provider', { jobTitle: 'FORGED TITLE', mainSpecialty: 'FORGED SPECIALTY', currentBio: 'Certified by NASA, 99 projects', userId: 'victim' } as any);
  assert.ok(result.suggestedBio);
  assert.deepEqual(x.reads[0].where, { userId: 'authenticated-provider' });
  assert.match(x.prompts[0].prompt, /مطور مواقع/);
  assert.match(x.prompts[0].prompt, /تطوير المواقع/);
  assert.doesNotMatch(x.prompts[0].prompt, /FORGED|NASA|99|victim/);
  assert.match(x.prompts[0].prompt, /Not verified credentials/);
  assert.equal(x.writes(), 0);
});

test('bio: new onboarding profile uses bounded draft title and unchanged experience range', async t => {
  const x = await load(t, { profile: null });
  await x.service.suggestBio('new-provider', { jobTitle: 'مصمم', experienceRange: '1 الى 3 سنوات' });
  assert.equal(JSON.parse(x.prompts[0].prompt).experienceRange, '1 الى 3 سنوات');
  assert.equal(JSON.parse(x.prompts[0].prompt).jobTitle, 'مصمم');
});

test('bio: insufficient input rejected before generation', async t => {
  const x = await load(t, { profile: null });
  await assert.rejects(x.service.suggestBio('p', {}), (e: any) => e.statusCode === 400);
  assert.equal(x.prompts.length, 0);
});

for (const method of ['suggestBio', 'suggestSkills'] as const) {
  test(`${method}: unavailable Gemini gives honest 503, zero writes`, async t => {
    const x = await load(t, { unavailable: true });
    await assert.rejects(x.service[method]('p', {}), (e: any) => e.statusCode === 503 && /تعذر إنشاء اقتراح/.test(e.message));
    assert.equal(x.writes(), 0);
  });
}

for (const output of [null, [], {}, { suggestedBio: 12 }, { suggestedBio: '   ' }, { suggestedBio: 'أ'.repeat(501) }, { suggestedBio: 'نص', extra: true },
  { suggestedBio: 'لدي 10 سنوات خبرة' }, { suggestedBio: 'أتممت ١٠ مشاريع' }, { suggestedBio: 'حاصل على شهادة معتمدة' },
  { suggestedBio: 'عملت لدى شركة عالمية' }, { suggestedBio: 'تقييمي ممتاز من العملاء' }, { suggestedBio: 'Certified professional' },
  { suggestedBio: 'Award winning expert' }]) {
  test(`bio: rejects malformed/unsupported output ${JSON.stringify(output).slice(0, 65)}`, async t => {
    const x = await load(t, { output: output === null ? false : output });
    await assert.rejects(x.service.suggestBio('p', {}), (e: any) => e.statusCode === 503);
    assert.equal(x.writes(), 0);
  });
}

test('bio: accepts exactly 500 characters and trims whitespace', async t => {
  const x = await load(t, { output: { suggestedBio: ' ' + 'أ'.repeat(498) + ' ' } });
  assert.equal((await x.service.suggestBio('p', {})).suggestedBio.length, 498);
});

test('skills: only real names, canonical mapping, existing names excluded; zero writes', async t => {
  const x = await load(t, { output: { suggestedSkills: [' css ', 'typescript'] } });
  assert.deepEqual(await x.service.suggestSkills('authenticated-provider', {}), { suggestedSkills: ['CSS', 'TypeScript'] });
  assert.deepEqual(x.reads[0].where, { userId: 'authenticated-provider' });
  const prompt = JSON.parse(x.prompts[0].prompt);
  assert.deepEqual(prompt.candidateSkills, ['CSS', 'TypeScript']);
  assert.doesNotMatch(x.prompts[0].prompt, /"id"/);
  assert.equal(x.writes(), 0);
});

for (const output of [{}, [], { suggestedSkills: 'CSS' }, { suggestedSkills: [''] }, { suggestedSkills: ['CSS', ' css '] },
  { suggestedSkills: ['unknown-skill-id'] }, { suggestedSkills: ['Invented Skill'] }, { suggestedSkills: ['HTML'] },
  { suggestedSkills: [{ id: 'invented', name: 'CSS' }] }, { suggestedSkills: ['a'.repeat(41)] },
  { suggestedSkills: Array.from({ length: 9 }, (_, i) => `Skill${i}`) }, { suggestedSkills: ['CSS'], extra: 1 }]) {
  test(`skills: rejects malformed, duplicate, oversized, existing or non-taxonomy output ${JSON.stringify(output).slice(0, 55)}`, async t => {
    const rows = ['HTML', 'CSS', 'a'.repeat(41), ...Array.from({ length: 9 }, (_, i) => `Skill${i}`)].map(name => ({ name }));
    const x = await load(t, { output, rows });
    await assert.rejects(x.service.suggestSkills('p', {}), (e: any) => e.statusCode === 503);
    assert.equal(x.writes(), 0);
  });
}

test('skills: accepts eight real skills at the length boundary', async t => {
  const names = Array.from({ length: 8 }, (_, i) => 'a'.repeat(39) + String(i));
  const x = await load(t, { rows: names.map(name => ({ name })), output: { suggestedSkills: names } });
  assert.deepEqual((await x.service.suggestSkills('p', {})).suggestedSkills, names);
});

test('skills: no taxonomy candidates means empty result, no provider call or write', async t => {
  const x = await load(t, { rows: [] });
  assert.deepEqual(await x.service.suggestSkills('p', {}), { suggestedSkills: [] });
  assert.equal(x.prompts.length, 0);
  assert.equal(x.writes(), 0);
});

test('skills: relevant subset may be empty without fabricated fallback', async t => {
  const x = await load(t, { output: { suggestedSkills: [] } });
  assert.deepEqual(await x.service.suggestSkills('p', {}), { suggestedSkills: [] });
});

test('DTOs reject identity injection, unsupported facts, invalid types and oversized input', () => {
  for (const schema of [providerBioSuggestSchema, providerSkillsSuggestSchema]) {
    assert.equal(schema.safeParse({}).success, true);
    for (const value of [{ userId: 'victim' }, { currentBio: 'fabricated achievements' }, { yearsOfExperience: 99 }, { jobTitle: 'x'.repeat(121) },
      { experienceRange: '99 years' }, { existingSkills: [''] }, { existingSkills: ['x'.repeat(41)] }, { existingSkills: Array(31).fill('CSS') }]) {
      assert.equal(schema.safeParse(value).success, false);
    }
  }
});
