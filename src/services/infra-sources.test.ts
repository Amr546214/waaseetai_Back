import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InfraSources } from './infra-sources';

const root = mkdtempSync(path.join(tmpdir(), 'qa-iso-mon-cg-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
let clock = Date.parse('2026-11-09T12:00:00Z');
const mk = (env: any = {}, fetchImpl?: any, cg = root) => { const s = new InfraSources(); s.deps = { cgroupRoot: cg, diskPath: () => root, fetchImpl: fetchImpl ?? (async () => { throw new Error('external call must not happen'); }), now: () => new Date(clock), env }; return s; };
const get = (rows: any[], k: string) => rows.find(r => r.key === k);
const json = (body: unknown, init: any = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();

test('container: cgroup v2 memory + cpu (needs two reads) + disk, each with a precise container-only scope, never "server"', async () => {
	const v2 = path.join(root, 'v2'); mkdirSync(v2);
	writeFileSync(`${v2}/memory.current`, String(256 * 1048576)); writeFileSync(`${v2}/memory.max`, String(1024 * 1048576)); writeFileSync(`${v2}/cpu.stat`, 'usage_usec 1000000\nuser_usec 1\n');
	const s = mk({}, undefined, v2);
	let rows = await s.container();
	assert.equal(get(rows, 'ctr_mem_used').value, 256); assert.equal(get(rows, 'ctr_mem_limit_pct').value, 25);
	assert.equal(get(rows, 'ctr_cpu').status, 'unavailable'); assert.match(get(rows, 'ctr_cpu').reason, /قراءتين/);
	assert.equal(get(rows, 'ctr_disk_used_pct').status, 'measured'); assert.ok(get(rows, 'ctr_disk_free').value >= 0);
	for (const r of rows) { assert.match(r.scope, /حاوية|نظام الملفات الذي يحوي مجلد التطبيق/); assert.ok(!r.scope.includes('السيرفر'), r.key); assert.match(r.scope, /وليس|ليس/, r.key); assert.ok(r.source && r.readAt); }
	clock += 10_000; writeFileSync(`${v2}/cpu.stat`, 'usage_usec 6000000\n'); // +5 s of CPU in 10 s = 50% of one core
	rows = await s.container(); assert.equal(get(rows, 'ctr_cpu').value, 50);
	clock += 10_000; writeFileSync(`${v2}/cpu.stat`, 'usage_usec 10\n'); rows = await s.container(); assert.equal(get(rows, 'ctr_cpu').value, null, 'a counter reset is not a negative number');
});

test('container: cgroup v1, unlimited memory, and no cgroup at all are reported honestly', async () => {
	const v1 = path.join(root, 'v1'); mkdirSync(`${v1}/memory`, { recursive: true }); mkdirSync(`${v1}/cpuacct`);
	writeFileSync(`${v1}/memory/memory.usage_in_bytes`, String(100 * 1048576)); writeFileSync(`${v1}/memory/memory.limit_in_bytes`, '9223372036854771712'); writeFileSync(`${v1}/cpuacct/cpuacct.usage`, '1000000000');
	let rows = await mk({}, undefined, v1).container();
	assert.equal(get(rows, 'ctr_mem_used').value, 100); assert.equal(get(rows, 'ctr_mem_limit_pct').value, null); assert.match(get(rows, 'ctr_mem_limit_pct').reason, /بلا حد/);
	rows = await mk({}, undefined, path.join(root, 'nothing')).container();
	for (const k of ['ctr_mem_used', 'ctr_mem_limit_pct', 'ctr_cpu']) { assert.equal(get(rows, k).status, 'unavailable', k); assert.equal(get(rows, k).value, null); assert.match(get(rows, k).reason, /cgroup/); }
});

test('adapters unconfigured: every external indicator is «غير متاح» with the exact missing variable, and nothing is fetched', async () => {
	const rows = await mk({}).external();
	const need: Record<string, string> = { host_cpu: 'HOST_METRICS_URL', host_mem_pct: 'HOST_METRICS_URL', host_disk_pct: 'HOST_METRICS_URL', ctr_running: 'CONTAINER_STATUS_URL', ctr_not_running: 'CONTAINER_STATUS_URL', ctr_restarts: 'CONTAINER_STATUS_URL', edge_requests: 'EDGE_STATS_URL', edge_hit_ratio: 'EDGE_STATS_URL', waf_blocked: 'WAF_STATUS_URL' };
	for (const [k, v] of Object.entries(need)) { const r = get(rows, k); assert.equal(r.status, 'unavailable', k); assert.equal(r.value, null); assert.ok(r.reason.includes(v), k); }
});

test('adapters measured: host (with the provider scope), containers, edge, waf; readAt is the provider collection time', async () => {
	const calls: string[] = []; const auth: string[] = [];
	const bodies: Record<string, unknown> = {
		'metrics.internal:9100': { schemaVersion: 1, collectedAt: iso(-30_000), scope: 'المضيف كاملًا (vps-1)', cpuPercent: 12.5, memoryUsedBytes: 4 * 1073741824, memoryTotalBytes: 8 * 1073741824, diskUsedBytes: 20 * 1073741824, diskTotalBytes: 80 * 1073741824 },
		'docker-proxy.internal:2375': { schemaVersion: 1, collectedAt: iso(-10_000), containers: [{ name: 'api', state: 'running', restartCount: 2 }, { name: 'db', state: 'running', restartCount: 0 }, { name: 'worker', state: 'restarting', restartCount: 5 }] },
		'edge.internal': { schemaVersion: 1, collectedAt: iso(-60_000), windowMinutes: 60, requests: 1000, cacheHitRatioPercent: 91.5 },
		'waf.internal': { schemaVersion: 1, collectedAt: iso(-60_000), windowMinutes: 60, blockedRequests: 7 },
	};
	const f = async (url: URL, init: any) => { calls.push(url.host); auth.push(init.headers.authorization ?? ''); return json(bodies[url.host]); };
	const env = { MONITORING_ALLOWED_HOSTS: 'metrics.internal:9100, docker-proxy.internal:2375,edge.internal,waf.internal', HOST_METRICS_URL: 'http://metrics.internal:9100/m', HOST_METRICS_TOKEN: 'tok-secret-1', CONTAINER_STATUS_URL: 'http://docker-proxy.internal:2375/c', EDGE_STATS_URL: 'https://edge.internal/e', WAF_STATUS_URL: 'https://waf.internal/w' };
	const rows = await mk(env, f).external();
	assert.equal(get(rows, 'host_cpu').value, 12.5); assert.equal(get(rows, 'host_cpu').scope, 'المضيف كاملًا (vps-1)'); assert.equal(get(rows, 'host_cpu').readAt, iso(-30_000));
	assert.equal(get(rows, 'host_mem_pct').value, 50); assert.equal(get(rows, 'host_disk_pct').value, 25);
	assert.equal(get(rows, 'ctr_running').value, 2); assert.equal(get(rows, 'ctr_not_running').value, 1); assert.equal(get(rows, 'ctr_restarts').value, 7); assert.match(get(rows, 'ctr_running').scope, /3 حاوية/);
	assert.equal(get(rows, 'edge_hit_ratio').value, 91.5); assert.equal(get(rows, 'edge_hit_ratio').group, 'cdn'); assert.match(get(rows, 'edge_requests').scope, /60 دقيقة/); assert.equal(get(rows, 'waf_blocked').value, 7);
	assert.equal(auth[0], 'Bearer tok-secret-1');
	const text = JSON.stringify(rows); for (const leak of ['tok-secret-1', 'metrics.internal', 'docker-proxy', '/m', 'worker']) assert.ok(!text.includes(leak), `leaks ${leak}`);
	const n = calls.length; await mk(env, f).external(); // another instance has its own cache; the SAME instance must not refetch within 60 s
	const s = mk(env, f); await s.external(); const n2 = calls.length; await s.external(); assert.equal(calls.length, n2, 'cached for 60 s'); assert.ok(n > 0);
	clock += 61_000; await s.external(); assert.ok(calls.length > n2, 'fetched again after the cache'); clock -= 61_000;
});

test('adapters refuse: host not on the allow-list, redirects, non-JSON, oversized, contract mismatch, future/stale data, HTTP error, timeout/failure', async () => {
	const ok = { schemaVersion: 1, collectedAt: iso(-1000), windowMinutes: 5, blockedRequests: 1 };
	const run = async (env: any, f: any) => get(await mk({ WAF_STATUS_URL: 'https://waf.internal/w', ...env }, f).external(), 'waf_blocked');
	const allow = { MONITORING_ALLOWED_HOSTS: 'waf.internal' };
	let called = 0; const spy = async () => { called++; return json(ok); };
	let r = await run({ MONITORING_ALLOWED_HOSTS: 'other.internal' }, spy); assert.equal(r.status, 'error'); assert.match(r.reason, /المسموحة/); assert.equal(called, 0, 'a non-allow-listed host is never contacted');
	r = await run({}, spy); assert.match(r.reason, /المسموحة/); assert.equal(called, 0);
	r = await run({ ...allow, WAF_STATUS_URL: 'ftp://waf.internal/w' }, spy); assert.match(r.reason, /المسموحة/);
	r = await run({ ...allow, WAF_STATUS_URL: 'not a url' }, spy); assert.match(r.reason, /غير صالح/);
	let seen: any; r = await run(allow, async (_u: any, init: any) => { seen = init; return json(ok); }); assert.equal(seen.redirect, 'error'); assert.ok(seen.signal); assert.equal(r.status, 'measured');
	r = await run(allow, async () => { throw new TypeError('redirect mode is set to error'); }); assert.equal(r.status, 'error'); assert.ok(!r.reason.includes('redirect mode'));
	r = await run(allow, async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })); assert.match(r.reason, /ليس JSON/);
	r = await run(allow, async () => json(ok, { headers: { 'content-type': 'application/json', 'content-length': '99999' } })); assert.match(r.reason, /أكبر/);
	r = await run(allow, async () => new Response(JSON.stringify({ ...ok, pad: 'x'.repeat(20000) }), { status: 200, headers: { 'content-type': 'application/json' } })); assert.match(r.reason, /أكبر|العقد/);
	r = await run(allow, async () => json({ ...ok, extra: 1 })); assert.match(r.reason, /العقد/);
	r = await run(allow, async () => json({ ...ok, blockedRequests: -1 })); assert.match(r.reason, /العقد/);
	r = await run(allow, async () => json({ ...ok, collectedAt: iso(3_600_000) })); assert.match(r.reason, /المستقبل/);
	r = await run(allow, async () => json({ ...ok, collectedAt: iso(-3_600_000) })); assert.equal(r.status, 'unavailable'); assert.match(r.reason, /١٥ دقيقة/); assert.equal(r.value, null);
	r = await run(allow, async () => new Response('x', { status: 500 })); assert.equal(r.status, 'error');
	r = await run(allow, async () => { throw new Error('ECONNREFUSED 10.0.0.5'); }); assert.ok(!JSON.stringify(r).includes('10.0.0.5'));
	r = await run(allow, async (_u: any, init: any) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))); assert.equal(r.status, 'error'); assert.match(r.reason, /المهلة/);
});
