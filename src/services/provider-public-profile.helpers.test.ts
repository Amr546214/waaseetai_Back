import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessmentDetails, buildCompanySummary, withSpecialtyName } from './provider-public-profile.helpers';

// Pure helpers behind GET /provider/profile/public — no DB, no mocks.

const attempt = (over: any = {}) => ({
  totalQuestions: 20,
  timeLimitMinutes: 15,
  startedAt: new Date('2026-09-01T10:00:00.000Z'),
  completedAt: new Date('2026-09-01T10:09:30.000Z'),
  submittedAnswers: { '1': 'a', '2': 'b', '3': 'c' },
  score: 85,
  feedbackAr: 'ممتاز',
  strengths: ['س1'],
  weaknesses: ['ض1'],
  ...over,
});

test('buildAssessmentDetails: no attempt -> null (no invented card)', () => {
  assert.equal(buildAssessmentDetails(null), null);
  assert.equal(buildAssessmentDetails(undefined), null);
});

test('buildAssessmentDetails: real values come from the attempt only', () => {
  const d = buildAssessmentDetails(attempt())!;
  assert.equal(d.totalQuestions, 20);
  assert.equal(d.timeLimitMinutes, 15);
  assert.equal(d.timeSpentMinutes, 10); // 9m30s rounds to 10
  assert.equal(d.answeredCount, 3);
  assert.equal(d.score, 85);
});

test('buildAssessmentDetails: columns that are null stay null — no `|| 20` / `|| 12` fallback', () => {
  const d = buildAssessmentDetails(attempt({ totalQuestions: null, timeLimitMinutes: null }))!;
  assert.equal(d.totalQuestions, null);
  assert.equal(d.timeLimitMinutes, null);
  assert.equal(d.timeTakenMinutes, null);
  assert.notEqual(d.totalQuestions, 20);
  assert.notEqual(d.timeTakenMinutes, 12);
});

test('buildAssessmentDetails: timeSpentMinutes is null when the attempt has not completed; answeredCount is null when no answers were submitted', () => {
  const d = buildAssessmentDetails(attempt({ completedAt: null, submittedAnswers: null }))!;
  assert.equal(d.timeSpentMinutes, null);
  assert.equal(d.answeredCount, null);
  // an empty map of answers is a real 0
  assert.equal(buildAssessmentDetails(attempt({ submittedAnswers: {} }))!.answeredCount, 0);
  // arrays are not an answers map
  assert.equal(buildAssessmentDetails(attempt({ submittedAnswers: ['a'] }))!.answeredCount, null);
});

test('buildAssessmentDetails: timeTakenMinutes stays for compatibility but is the time LIMIT (deprecated), never the time spent', () => {
  const d = buildAssessmentDetails(attempt())!;
  assert.equal(d.timeTakenMinutes, 15);
  assert.notEqual(d.timeTakenMinutes, d.timeSpentMinutes);
});

test('buildAssessmentDetails: completedAt is never a fabricated "now"', () => {
  assert.equal(buildAssessmentDetails(attempt({ completedAt: null }), { passedAt: null })!.completedAt, null);
  const passed = new Date('2026-09-02T00:00:00.000Z');
  assert.equal(buildAssessmentDetails(attempt({ completedAt: null }), { passedAt: passed })!.completedAt?.toISOString(), passed.toISOString());
  // a negative duration (clock skew) is floored at 0 rather than reported as negative
  assert.equal(buildAssessmentDetails(attempt({ completedAt: new Date('2026-09-01T09:00:00.000Z') }))!.timeSpentMinutes, 0);
});

test('withSpecialtyName: adds the Arabic name next to specialtyId and drops the nested relation', () => {
  const out = withSpecialtyName({ id: 's1', specialtyId: 'sp1', specialty: { nameAr: 'تطوير الويب', name: 'web' } });
  assert.equal(out.specialtyName, 'تطوير الويب');
  assert.equal(out.specialtyId, 'sp1');
  assert.equal('specialty' in out, false);
  assert.equal(withSpecialtyName({ id: 's2', specialtyId: 'sp2', specialty: { nameAr: null, name: 'web' } }).specialtyName, 'web');
  assert.equal(withSpecialtyName({ id: 's3', specialtyId: null, specialty: null }).specialtyName, null);
});

test('buildCompanySummary: individuals get null; companies get only the company name and a number', () => {
  assert.equal(buildCompanySummary({ accountType: 'PROVIDER_INDIVIDUAL', companyName: 'x', activeTeamMembersCount: 3 }), null);
  const c = buildCompanySummary({ accountType: 'PROVIDER_COMPANY', companyName: 'شركة', activeTeamMembersCount: 4 })!;
  assert.deepEqual(c, { companyName: 'شركة', activeTeamMembersCount: 4 });
  assert.deepEqual(Object.keys(c).sort(), ['activeTeamMembersCount', 'companyName']);
  assert.equal(buildCompanySummary({ accountType: 'PROVIDER_COMPANY', companyName: null, activeTeamMembersCount: 0 })!.companyName, null);
});
