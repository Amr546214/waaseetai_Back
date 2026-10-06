import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { clientWith } from './ai-feature.test-helpers';
import { LlmError, LlmErrorCode, LLM_UNAVAILABLE_MESSAGE, LLM_NOT_CONFIGURED_MESSAGE } from '../llm/llm.errors';

const REQUEST = {
  title: 'متجر إلكتروني', description: 'نحتاج متجراً. تواصل: owner@shop.com أو 0501234567', requiredSkills: ['React', 'Node.js'], subSpecialties: ['واجهات'],
  outputs: 'موقع كامل', minBudget: 1000, maxBudget: 3000, expectedDurationDays: 30, specialty: { nameAr: 'تطوير الويب' },
};
const PROFILE = { yearsOfExperience: 5, mainSpecialty: 'تطوير الويب', subSpecialties: ['واجهات'], skills: [{ name: 'React' }, { name: 'Python' }], providerSpecialties: [{ specialty: { nameAr: 'تطوير الويب' } }] };

type DbState = { request?: any; project?: any; profile?: any; gamification?: any };
function mockDb(t: TestContext, o: DbState) {
  const prisma: any = {
    clientRequest: { findFirst: async () => ('request' in o ? o.request : REQUEST) },
    project: { findFirst: async () => o.project ?? null },
    providerProfile: { findUnique: async () => ('profile' in o ? o.profile : PROFILE) },
    providerGamification: { findUnique: async () => ('gamification' in o ? o.gamification : { currentLevelIndex: 3 }) },
  };
  t.mock.module('../../config/db', { namedExports: { prisma } });
}
// `state` is mutable: a test can change what the mocked database returns between calls (the module is mocked once per test)
async function load(t: TestContext, respond: (input: any) => unknown, o: DbState = {}, calls: any[] = [], config?: any) {
  mockDb(t, o);
  const { ProjectFitService } = await import(`./project-fit.service.ts?f=${Date.now()}-${Math.random()}`);
  const svc = new ProjectFitService(clientWith((i) => respondRef.fn(i), calls, config));
  respondRef.fn = respond;
  return Object.assign(svc, { db: o, setRespond(fn: (i: any) => unknown) { respondRef.fn = fn; } });
}
const respondRef: { fn: (i: any) => unknown } = { fn: () => ({}) };

// a deterministic "model" that derives its answer ONLY from the JSON it receives
const honest = (input: any) => {
  const need: string[] = input.project.requiredSkills, have: string[] = input.provider.skills;
  const matched = need.filter((s) => have.includes(s)), missing = need.filter((s) => !have.includes(s));
  return {
    overallFit: matched.length === need.length ? 'HIGH' : matched.length ? 'MEDIUM' : 'LOW',
    summary: `يطابق المقدّم ${matched.length} من ${need.length} مهارات مطلوبة`,
    matchPoints: matched.map((s) => ({ text: `يمتلك المهارة ${s}`, basedOn: ['project.requiredSkills', 'provider.skills'] })),
    gaps: missing.map((s) => ({ text: `المهارة ${s} مطلوبة وغير موجودة في مهاراته`, basedOn: ['project.requiredSkills'] })),
  };
};

test('grounded answer: cites only sent fields; summary and points quote the input skills', async (t) => {
  const svc = await load(t, honest);
  const r = await svc.analyze('u1', 'req-1');
  assert.equal(r.generationSource, 'LLM');
  assert.equal(r.insufficientData, false);
  assert.deepEqual(r.analysis.matchPoints.map((p: any) => p.text), ['يمتلك المهارة React']);
  assert.deepEqual(r.analysis.gaps.map((p: any) => p.text), ['المهارة Node.js مطلوبة وغير موجودة في مهاراته']);
  assert.equal(r.analysis.summary, 'يطابق المقدّم 1 من 2 مهارات مطلوبة');
  assert.ok(r.inputsUsed.includes('project.requiredSkills'));
  assert.ok(r.unavailableFields.includes('project.requirements'), 'a field with no data is reported as unavailable, not invented');
});

test('changing the input changes the output', async (t) => {
  const svc = await load(t, honest);
  const a = await svc.analyze('u1', 'req-1');
  svc.db.profile = { ...PROFILE, skills: [{ name: 'React' }, { name: 'Node.js' }] };
  const b = await svc.analyze('u2', 'req-1');
  assert.notDeepEqual(a.analysis, b.analysis);
  assert.equal(b.analysis.overallFit, 'HIGH');
  assert.equal(b.analysis.gaps.length, 0);
});

test('the payload sent to the model carries no personal data and no field outside the allowlist', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, undefined, calls);
  await svc.analyze('u1', 'req-1');
  const sent = calls[0].user;
  assert.doesNotMatch(sent, /owner@shop\.com|0501234567/);
  assert.match(sent, /\[محجوب\]/);
  assert.deepEqual(Object.keys(JSON.parse(sent)).sort(), ['project', 'provider']);
  assert.equal('firstName' in JSON.parse(sent).provider, false);
});

test('empty data: no model call and no invented analysis', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, { request: { ...REQUEST, description: '', requiredSkills: [], outputs: null }, profile: { ...PROFILE, skills: [], providerSpecialties: [], mainSpecialty: null, subSpecialties: [], yearsOfExperience: null }, gamification: null }, calls);
  const r = await svc.analyze('u1', 'req-1');
  assert.equal(r.insufficientData, true);
  assert.equal(r.analysis, null);
  assert.equal(r.generationSource, null);
  assert.equal(calls.length, 0);
});

test('model failure → fixed 503 Arabic message without a provider name', async (t) => {
  const svc = await load(t, () => new LlmError(LlmErrorCode.UNKNOWN, 'boom'));
  await assert.rejects(svc.analyze('u1', 'req-1'), (e: any) => e.statusCode === 503 && e.message === LLM_UNAVAILABLE_MESSAGE && !/gemini|google/i.test(e.message));
});

test('env not configured → 503 NOT_CONFIGURED', async (t) => {
  const svc = await load(t, honest, undefined, [], null);
  await assert.rejects(svc.analyze('u1', 'req-1'), (e: any) => e.statusCode === 503 && e.code === 'NOT_CONFIGURED' && e.message === LLM_NOT_CONFIGURED_MESSAGE);
});

test('a number or basedOn path that was not sent is rejected (503)', async (t) => {
  const svc = await load(t, honest);
  svc.setRespond((i: any) => ({ ...honest(i), summary: 'يطابق 9 مهارات' }));
  await assert.rejects(svc.analyze('u1', 'req-1'), (e: any) => e.statusCode === 503);
  svc.setRespond((i: any) => ({ ...honest(i), gaps: [{ text: 'فجوة', basedOn: ['project.requirements'] }] }));
  await assert.rejects(svc.analyze('u2', 'req-1'), (e: any) => e.statusCode === 503);
  svc.setRespond((i: any) => ({ ...honest(i), gaps: [{ text: 'فجوة', basedOn: [] }] }));
  await assert.rejects(svc.analyze('u3', 'req-1'), (e: any) => e.statusCode === 503);
});

test('project not open / not found → 404; provider without a profile → 404', async (t) => {
  const svc = await load(t, honest, { request: null });
  await assert.rejects(svc.analyze('u1', 'x'), (e: any) => e.statusCode === 404);
  svc.db.request = REQUEST; svc.db.profile = null;
  await assert.rejects(svc.analyze('u1', 'x'), (e: any) => e.statusCode === 404);
});

test('a Project (not ClientRequest) is read through its requirements[] and fixed budget', async (t) => {
  const calls: any[] = [];
  const project = { title: 'تطبيق', description: 'وصف', requirements: ['دفع إلكتروني'], subSpecialties: [], outputs: null, budgetMin: null, budgetMax: null, budgetFixed: 2500, deliveryDays: 20, specialty: 'تطوير' };
  const svc = await load(t, (i: any) => ({ overallFit: 'MEDIUM', summary: 'تطابق جزئي', matchPoints: [{ text: 'المشروع يطلب دفع إلكتروني', basedOn: ['project.requirements'] }], gaps: [] }), { request: null, project }, calls);
  const r = await svc.analyze('u1', 'p1');
  assert.equal(JSON.parse(calls[0].user).project.budgetFixed, 2500);
  assert.deepEqual(JSON.parse(calls[0].user).project.requirements, ['دفع إلكتروني']);
  assert.equal(r.analysis.overallFit, 'MEDIUM');
});
