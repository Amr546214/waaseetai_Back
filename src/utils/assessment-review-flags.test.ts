import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessmentFlagConfig, evaluateAssessment, periodicCycle } from './assessment-review-flags';

// #20 — the thresholds, the pattern detectors and the environment overrides. Flags are advisory data; nothing here can fail an attempt.
const T0 = new Date('2026-01-01T10:00:00Z');
const after = (s: number) => new Date(T0.getTime() + s * 1000);
const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
const answersOf = (f: (i: number) => string) => Object.fromEntries(ids.map((id, i) => [id, f(i)]));
const varied = answersOf(i => 'abcd'[(i * 7 + (i >> 1)) % 4]);
const slowLog = ids.map((id, i) => ({ q: id, a: 'a', t: T0.getTime() + (i + 1) * 20_000 }));
const cfg = assessmentFlagConfig({} as any);

test('defaults are the approved values: 3 s per question, 80 s total, 90% pattern', () => {
	assert.deepEqual(cfg, { minSecondsPerQuestion: 3, minTotalSeconds: 80, patternRatio: 0.9, fastAnswerMinCount: 3 });
});

test('environment variables override them; invalid / out-of-range values fall back to the default', () => {
	const c = assessmentFlagConfig({ ASSESSMENT_MIN_SECONDS_PER_QUESTION: '5', ASSESSMENT_MIN_TOTAL_SECONDS: '120', ASSESSMENT_PATTERN_RATIO: '0.8', ASSESSMENT_FAST_ANSWER_MIN_COUNT: '2' } as any);
	assert.deepEqual(c, { minSecondsPerQuestion: 5, minTotalSeconds: 120, patternRatio: 0.8, fastAnswerMinCount: 2 });
	const bad = assessmentFlagConfig({ ASSESSMENT_MIN_SECONDS_PER_QUESTION: 'abc', ASSESSMENT_MIN_TOTAL_SECONDS: '-5', ASSESSMENT_PATTERN_RATIO: '5', ASSESSMENT_FAST_ANSWER_MIN_COUNT: '' } as any);
	assert.deepEqual(bad, cfg);
});

test('a normal attempt is not marked', () => {
	const r = evaluateAssessment({ questionIds: ids, answers: varied, startedAt: T0, completedAt: after(420), answerLog: slowLog }, cfg);
	assert.equal(r.flagged, false);
	assert.deepEqual(r.flags, []);
	assert.equal(r.measured.fastAnswers, 0);
});

test('total time: 79 s is marked, 80 s is not (boundary)', () => {
	const mk = (s: number) => evaluateAssessment({ questionIds: ids, answers: varied, startedAt: T0, completedAt: after(s) }, cfg);
	assert.deepEqual(mk(79).flags.map(f => f.code), ['TOTAL_TIME_TOO_SHORT']);
	assert.equal(mk(80).flagged, false);
});

test('per-question time: three answers less than 3 s after the previous one mark the attempt; two do not; exactly 3 s is fine', () => {
	const log = (gaps: number[]) => { let t = T0.getTime(); return gaps.map((g, i) => ({ q: String(i + 1), a: 'a', t: (t += g * 1000) })); };
	const run = (gaps: number[]) => evaluateAssessment({ questionIds: ids, answers: varied, startedAt: T0, completedAt: after(400), answerLog: log(gaps) }, cfg);
	assert.deepEqual(run([2, 1, 2.9, 30, 30]).flags.map(f => f.code), ['FAST_ANSWERS']);
	assert.equal(run([2, 1, 30, 30]).flagged, false);
	assert.equal(run([3, 3, 3, 3]).flagged, false);
	assert.equal(run([2, 1, 2.9]).measured.fastAnswers, 3);
});

test('without any per-answer log (an old client) only the other checks run; fastAnswers is null, not 0', () => {
	const r = evaluateAssessment({ questionIds: ids, answers: varied, startedAt: T0, completedAt: after(300) }, cfg);
	assert.equal(r.measured.fastAnswers, null);
	assert.equal(r.flagged, false);
});

test('uniform answers: 18 of 20 the same (90%) is marked, 17 of 20 is not', () => {
	const mk = (same: number) => evaluateAssessment({ questionIds: ids, answers: answersOf(i => (i < same ? 'a' : 'bcd'[i % 3])), startedAt: T0, completedAt: after(400) }, cfg);
	assert.ok(mk(18).flags.some(f => f.code === 'UNIFORM_ANSWERS'));
	assert.equal(mk(17).flags.some(f => f.code === 'UNIFORM_ANSWERS'), false);
	assert.equal(mk(18).measured.topShare, 0.9);
});

test('repeating pattern: a-b-c-d-a-b-c-d… and a-b-a-b… are marked; a varied sequence is not; uniform is reported as uniform only', () => {
	assert.equal(periodicCycle('abcdabcdabcdabcd'.split('')), 4);
	assert.equal(periodicCycle('abababababab'.split('')), 2);
	assert.equal(periodicCycle('aaaaaaaaaa'.split('')), null);
	assert.equal(periodicCycle('abcdabcdabcdabca'.split('').concat(['b'])), null, 'one deviation breaks the cycle');
	assert.equal(periodicCycle('abcdabc'.split('')), null, 'too short to judge');
	const cyc = evaluateAssessment({ questionIds: ids, answers: answersOf(i => 'abcd'[i % 4]), startedAt: T0, completedAt: after(400) }, cfg);
	assert.deepEqual(cyc.flags.map(f => f.code), ['REPEATING_PATTERN']);
	assert.equal(cyc.measured.periodicCycle, 4);
	const uni = evaluateAssessment({ questionIds: ids, answers: answersOf(() => 'c'), startedAt: T0, completedAt: after(400) }, cfg);
	assert.deepEqual(uni.flags.map(f => f.code), ['UNIFORM_ANSWERS']);
});

test('few answers are not judged for patterns; flags carry Arabic labels; thresholds are echoed in the result', () => {
	const r = evaluateAssessment({ questionIds: ids, answers: { '1': 'a', '2': 'a', '3': 'a' }, startedAt: T0, completedAt: after(400) }, cfg);
	assert.equal(r.flagged, false);
	const f = evaluateAssessment({ questionIds: ids, answers: varied, startedAt: T0, completedAt: after(10) }, cfg);
	assert.match(f.flags[0].label, /[؀-ۿ]/);
	assert.deepEqual(f.thresholds, cfg);
});
