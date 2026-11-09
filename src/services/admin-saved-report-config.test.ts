import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReportDate, validReportRange } from './admin-saved-report-config';

test('saved report dates are real and use exact ISO calendar dates', () => {
  assert.equal(isReportDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-01-32', '2026-1-01', '0000-01-01', '2026-01-01T00:00:00Z']) {
    assert.equal(isReportDate(date), false, date);
  }
});

test('relative periods stay relative and custom windows cannot be empty or inverted', () => {
  assert.equal(validReportRange('30d', null, null), true);
  assert.equal(validReportRange('30d', '2026-01-01', null), false);
  assert.equal(validReportRange('custom', null, null), false);
  assert.equal(validReportRange('custom', '2026-02-02', '2026-02-01'), false);
  assert.equal(validReportRange('custom', '2026-02-01', '2026-02-01'), true);
  assert.equal(validReportRange('custom', null, '2026-02-01'), true);
  assert.equal(validReportRange('custom', '2026-02-01', null), true);
});
