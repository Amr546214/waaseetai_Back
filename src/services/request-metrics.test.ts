import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RequestMetrics, requestMetrics, requestMetricsMiddleware, WINDOW_MINUTES } from './request-metrics';

test('rolling window: counts per status class, 429 separately, percentiles are histogram upper bounds, old minutes drop out', () => {
	let t = 1_000_000 * 60_000; const m = new RequestMetrics(() => t);
	for (let i = 0; i < 90; i++) m.record(200, 5);   // <=10ms
	for (let i = 0; i < 6; i++) m.record(404, 40);   // <=50ms
	for (let i = 0; i < 3; i++) m.record(500, 700);  // <=1000ms
	m.record(429, 8);
	const s = m.snapshot();
	assert.deepEqual([s.total, s.s2, s.s4, s.s5, s.s429], [100, 90, 7, 3, 1]);
	assert.equal(s.p50?.ms, 10); assert.equal(s.p95?.ms, 50); assert.equal(s.p99?.ms, 1000); assert.equal(s.p99?.capped, false);
	t += 5 * 60_000; for (let i = 0; i < 5; i++) m.record(200, 9_000);
	const s2 = m.snapshot(); assert.equal(s2.total, 105); assert.equal(s2.p99?.capped, true, 'a value above the last edge is reported as capped, not invented');
	t += (WINDOW_MINUTES - 4) * 60_000; // first minute is now outside the window
	const s3 = m.snapshot(); assert.equal(s3.total, 5); assert.equal(s3.s5, 0);
	t += WINDOW_MINUTES * 60_000; const s4 = m.snapshot(); assert.equal(s4.total, 0); assert.equal(s4.p50, null, 'no requests = no percentile (never 0)');
});

test('middleware records status and latency only: no path, query, user or address is kept anywhere', async () => {
	requestMetrics.reset();
	const app = express(); app.use(requestMetricsMiddleware);
	app.get('/api/users/:id/secret', (_q, r) => { r.status(201).json({ ok: true }); });
	app.get('/limited', (_q, r) => { r.status(429).end(); });
	const srv = http.createServer(app); await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
	const port = (srv.address() as AddressInfo).port;
	try {
		await (await fetch(`http://127.0.0.1:${port}/api/users/abc-123/secret?token=zzz`)).text();
		await (await fetch(`http://127.0.0.1:${port}/limited`)).text();
		await (await fetch(`http://127.0.0.1:${port}/missing`)).text();
		await new Promise(r => setTimeout(r, 50));
		const s = requestMetrics.snapshot(); assert.equal(s.total, 3); assert.equal(s.s2, 1); assert.equal(s.s4, 2); assert.equal(s.s429, 1);
		const dump = JSON.stringify([...(requestMetrics as any).buckets.values()]) + JSON.stringify(s);
		for (const leak of ['abc-123', 'secret', 'token', 'zzz', 'limited', '127.0.0.1']) assert.ok(!dump.includes(leak), leak);
	} finally { srv.close(); requestMetrics.reset(); }
});
