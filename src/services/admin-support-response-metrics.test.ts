import assert from 'node:assert/strict';
import { test } from 'node:test';
import { responseMetrics } from './admin-support-response-metrics';

const at = new Date('2026-11-01T00:00:00Z');
const row = (hours: number | null, sla: 'MET' | 'LATE' | 'OVERDUE' | 'PENDING' | 'CLOSED' | null) => ({
  createdAt: at, firstReplyAt: hours === null ? null : new Date(+at + hours * 3600_000), senderId: hours === null ? null : 'staff', sla, closed: sla === 'CLOSED',
});
test('support metrics do not invent success for pending or unanswered tickets', () => {
  const result = responseMetrics([row(1, 'MET'), row(3, 'LATE'), row(null, 'OVERDUE'), row(null, 'PENDING'), row(null, 'CLOSED')]);
  assert.equal(result.averageFirstReplyHours, 2);
  assert.equal(result.slaRate, 33.3);
  assert.equal(result.measured, 3);
  assert.equal(result.pending, 1);
  assert.equal(result.closedWithoutReply, 1);
  assert.equal(result.withoutStaffReply, 3);
});
test('no data or disabled policy is unavailable rather than zero percent', () => {
  assert.equal(responseMetrics([]).averageFirstReplyHours, null);
  assert.equal(responseMetrics([]).slaRate, null);
  assert.equal(responseMetrics([row(2, null)]).slaRate, null);
  assert.equal(responseMetrics([{ ...row(null, null), closed: true }]).closedWithoutReply, 1);
  assert.equal(responseMetrics([row(-1, null)]).answered, 0);
});
