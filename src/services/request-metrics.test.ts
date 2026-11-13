import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { groupOf, recordRequest, requestMetricsSnapshot, resetRequestMetrics } from './request-metrics';

beforeEach(resetRequestMetrics);
test('paths are grouped by method + first two segments with ids collapsed (no per-user keys, bounded cardinality)', () => {
	assert.equal(groupOf('GET', '/api/projects/3f2b8c1e-aaaa-bbbb-cccc-123456789012/stages?x=1'), 'GET projects/:id');
	assert.equal(groupOf('POST', '/api/admin/system-settings'), 'POST admin/system-settings'); assert.equal(groupOf('GET', '/'), 'GET /');
});
test('snapshot counts requests/errors and reports percentile upper bounds only over the last 15 minutes', () => {
	const t = Date.now();
	for (const ms of [10, 20, 30, 40, 900]) recordRequest('GET', '/api/projects', 200, ms, t); recordRequest('GET', '/api/projects', 500, 3000, t); recordRequest('GET', '/api/projects', 404, 5, t);
	recordRequest('GET', '/api/old', 200, 10, t - 20 * 60_000);
	const s = requestMetricsSnapshot(t); const g = s.groups.find(x => x.group === 'GET projects')!;
	assert.equal(g.requests, 7); assert.equal(g.errors5xx, 1); assert.equal(g.errors4xx, 1); assert.ok(g.p50MsUpperBound! <= 50); assert.ok(g.p95MsUpperBound! >= 2500);
	assert.equal(s.groups.some(x => x.group === 'GET old'), false, 'outside the window'); assert.equal(s.totals.requests, 7);
});
