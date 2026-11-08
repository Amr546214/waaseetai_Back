import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/** Technical monitoring over HTTP on REAL PostgreSQL (qa_iso_mon_*): permission, measured vs unavailable branches, cache, payload hygiene, escalation readiness (read-only). No external service is ever called. */
after(closeEnv);
const P = '/admin/system-settings/technical-metrics', R = '/admin/system-settings/escalation-readiness';
async function fresh() {
	const e = await env(); const { technicalMonitoring } = await import('./technical-monitoring.service'); const { requestMetrics } = await import('./request-metrics');
	technicalMonitoring.reset(); requestMetrics.reset();
	const real = (await import('./technical-monitoring.service')).TechnicalMonitoringService; const base = new real().deps;
	technicalMonitoring.deps = { ...base, cdnConfigured: () => false, cdnUsage: async () => { throw new Error('external call must not happen'); } };
	return { e, svc: technicalMonitoring, base, requestMetrics };
}
const get = (j: any, key: string) => j.data.indicators.find((i: any) => i.key === key);

test('permission: no session 401, staff without settings.view/manage 403, settings.view and SUPER_ADMIN read', opts, async () => {
	const { e } = await fresh();
	assert.equal((await e.call('GET', P)).status, 401); assert.equal((await e.call('GET', R)).status, 401);
	const none = await mkStaff(e, ['users.view'], 'mn');
	assert.equal((await e.call('GET', P, none.user.id)).status, 403); assert.equal((await e.call('GET', R, none.user.id)).status, 403);
	const viewer = await mkStaff(e, ['settings.view'], 'mv');
	assert.equal((await e.call('GET', P, viewer.user.id)).status, 200); assert.equal((await e.call('GET', R, viewer.user.id)).status, 200);
	assert.equal((await e.call('GET', P, e.sa.id)).status, 200);
});

test('measured: real database readings, api process readings, every indicator has the full shape and a valid readAt', opts, async () => {
	const { e, svc, requestMetrics } = await fresh();
	requestMetrics.record(200, 5); requestMetrics.record(500, 30); requestMetrics.record(429, 2);
	const r = await e.call('GET', P, e.sa.id); assert.equal(r.status, 200);
	for (const i of r.json.data.indicators) {
		assert.ok(['api', 'database', 'backup', 'cdn'].includes(i.group)); assert.ok(['measured', 'unavailable', 'error'].includes(i.status));
		assert.ok(i.label && i.unit && i.source); assert.ok(Number.isFinite(Date.parse(i.readAt)), i.key);
		if (i.status === 'measured') assert.equal(typeof i.value, 'number', i.key); else { assert.equal(i.value, null, i.key); assert.ok(i.reason, `${i.key} needs a reason`); }
	}
	for (const k of ['db_latency', 'db_size', 'db_connections', 'db_active', 'db_conn_usage', 'db_deadlocks', 'db_temp_files']) assert.equal(get(r.json, k).status, 'measured', k);
	assert.ok(get(r.json, 'db_size').value > 0); assert.ok(get(r.json, 'db_connections').value >= 1);
	assert.ok(get(r.json, 'db_latency').value >= 0);
	assert.equal(get(r.json, 'api_requests').value, 3); assert.equal(get(r.json, 'api_5xx').value, 1); assert.equal(get(r.json, 'api_429').value, 1);
	assert.equal(get(r.json, 'api_5xx_rate').value, 33.33); assert.equal(get(r.json, 'api_p50').value, 10);
	assert.ok(get(r.json, 'api_rss').value > 0); assert.ok(get(r.json, 'api_uptime').value >= 0);
	svc.reset();
});

test('unavailable: no requests => rate/percentiles unavailable (not 0); backups always unavailable with the missing integration; CDN unconfigured; pg_stat_statements absent or unreadable', opts, async () => {
	const { e, svc, base, requestMetrics } = await fresh(); requestMetrics.reset();
	const r = await e.call('GET', P, e.sa.id);
	// the request that just ran is itself not counted here (the harness app has no metrics middleware), so the window is empty
	for (const k of ['api_5xx_rate', 'api_p50', 'api_p95', 'api_p99']) { assert.equal(get(r.json, k).status, 'unavailable', k); assert.equal(get(r.json, k).value, null); }
	assert.equal(get(r.json, 'api_requests').value, 0, 'a real zero count (the counter runs since start) is a measurement');
	for (const k of ['backup_last_success', 'backup_size', 'backup_restore_test']) { const i = get(r.json, k); assert.equal(i.status, 'unavailable'); assert.match(i.reason, /مهمة النسخ/); }
	for (const k of ['cdn_storage', 'cdn_bandwidth', 'cdn_transformations', 'cdn_resources', 'cdn_hit_ratio']) assert.equal(get(r.json, k).status, 'unavailable', k);
	assert.match(get(r.json, 'cdn_storage').reason, /غير مهيأ/);
	const ss = get(r.json, 'db_slow_queries'); assert.equal(ss.status, 'unavailable'); assert.match(ss.reason, /pg_stat_statements/);
	// extension present but its view cannot be read
	svc.reset(); svc.deps = { ...base, cdnConfigured: () => false, cdnUsage: async () => { throw new Error('no'); }, query: async sql => /FROM pg_extension/.test(sql) ? [{ present: 1 }] : /pg_stat_statements WHERE/.test(sql) ? Promise.reject(new Error('relation does not exist')) : base.query(sql) };
	const r2 = await e.call('GET', P, e.sa.id); assert.equal(get(r2.json, 'db_slow_queries').status, 'unavailable'); assert.match(get(r2.json, 'db_slow_queries').reason, /غير قابل للقراءة/);
	// extension present and readable
	svc.reset(); svc.deps = { ...svc.deps, query: async sql => /FROM pg_extension/.test(sql) ? [{ present: 1 }] : /pg_stat_statements WHERE/.test(sql) ? [{ slow: 2 }] : base.query(sql) };
	assert.equal(get((await e.call('GET', P, e.sa.id)).json, 'db_slow_queries').value, 2);
	svc.reset();
});

test('error branches: database failure is reported as error with a reason, never as a number; provider failure; provider success is mocked', opts, async () => {
	const { e, svc, base } = await fresh();
	svc.deps = { ...base, cdnConfigured: () => false, query: async () => { throw new Error('connection refused'); } };
	const r = await e.call('GET', P, e.sa.id);
	for (const k of ['db_latency', 'db_size', 'db_cache_hit', 'db_connections', 'db_slow_queries']) { const i = get(r.json, k); assert.equal(i.status, 'error', k); assert.equal(i.value, null); assert.ok(i.reason); }
	assert.ok(!JSON.stringify(r.json).includes('connection refused'), 'raw driver messages are not exposed');
	svc.reset(); svc.deps = { ...base, cdnConfigured: () => true, cdnUsage: async () => { throw new Error('401 invalid key sk-secret'); } };
	const r2 = await e.call('GET', P, e.sa.id); assert.equal(get(r2.json, 'cdn_storage').status, 'error'); assert.ok(!JSON.stringify(r2.json).includes('sk-secret'));
	svc.reset(); let calls = 0;
	svc.deps = { ...base, cdnConfigured: () => true, cdnUsage: async () => { calls++; return { storageBytes: 5 * 1048576, bandwidthBytes: 2 * 1048576, transformations: 12, resources: null, plan: 'Free' }; } };
	const r3 = await e.call('GET', P, e.sa.id);
	assert.equal(get(r3.json, 'cdn_storage').value, 5); assert.equal(get(r3.json, 'cdn_bandwidth').value, 2); assert.equal(get(r3.json, 'cdn_transformations').value, 12);
	assert.equal(get(r3.json, 'cdn_resources').status, 'unavailable'); assert.match(get(r3.json, 'cdn_storage').source, /Free/);
	assert.equal(get(r3.json, 'cdn_hit_ratio').status, 'unavailable');
	// the provider is not hit again within its own cache even after the main cache is dropped
	(svc as any).cache = null; await e.call('GET', P, e.sa.id); assert.equal(calls, 1);
	svc.reset();
});

test('cache: a second read within 15s does not query the database again; concurrent reads share one reading; after expiry it reads again', opts, async () => {
	const { e, svc, base } = await fresh(); let n = 0; let nowMs = Date.now();
	svc.deps = { ...base, now: () => new Date(nowMs), cdnConfigured: () => false, query: async sql => { n++; return base.query(sql); } };
	await Promise.all([e.call('GET', P, e.sa.id), e.call('GET', P, e.sa.id), e.call('GET', P, e.sa.id)]);
	const first = n; assert.ok(first > 0); const a = (await e.call('GET', P, e.sa.id)).json; assert.equal(n, first, 'served from cache'); assert.equal(a.data.cacheSeconds, 15);
	nowMs += 16_000; await e.call('GET', P, e.sa.id); assert.ok(n > first, 'read again after 15s');
	svc.reset();
});

test('payload hygiene: no secrets, no user data, no addresses in the response', opts, async () => {
	const { e, svc, base } = await fresh();
	const s = await e.prisma.user.findFirst({ where: { accountType: 'SUPER_ADMIN' } });
	svc.deps = { ...base, cdnConfigured: () => true, cdnUsage: async () => ({ storageBytes: 1, bandwidthBytes: 1, transformations: 1, resources: 1, plan: null }) };
	const text = (await e.call('GET', P, e.sa.id)).text;
	for (const bad of [process.env.CLOUDINARY_API_SECRET!, process.env.CLOUDINARY_API_KEY!, process.env.JWT_SECRET!, process.env.DATABASE_URL!, s!.email, s!.id, 'postgresql://', '127.0.0.1']) assert.ok(!text.includes(bad), `leaks ${bad.slice(0, 6)}`);
	svc.reset();
});

test('escalation readiness: closed by default, lists exactly which preconditions are missing, checks assignee permissions, changes nothing and offers no switch', opts, async () => {
	const { e, svc } = await fresh();
	const keep = { ...process.env }; for (const k of ['CASE_SLA_ENABLED', 'CASE_SLA_FROM', 'SUPPORT_SLA_FIRST_REPLY_HOURS', 'SUPPORT_SLA_TARGET_ADMIN_ID', 'DISPUTE_SLA_TARGET_ADMIN_ID']) delete process.env[k];
	try {
		const r = (await e.call('GET', R, e.sa.id)).json.data;
		assert.equal(r.automaticEscalation, 'closed'); assert.equal(r.summary, 'التصعيد الآلي مقفول'); assert.equal(r.ready, false);
		assert.deepEqual(r.preconditions.map((p: any) => p.met), [false, false, false, false, false, false]);
		assert.deepEqual(r.supportPermissions, ['support.review', 'support.reply']); assert.deepEqual(r.disputePermissions, ['disputes.view', 'disputes.resolve']);
		const sup = await mkStaff(e, ['support.review', 'support.reply'], 'sl'); const dis = await mkStaff(e, ['disputes.view'], 'dl'); // disputes.resolve is missing
		process.env.SUPPORT_SLA_TARGET_ADMIN_ID = sup.user.id; process.env.DISPUTE_SLA_TARGET_ADMIN_ID = dis.user.id; process.env.SUPPORT_SLA_FIRST_REPLY_HOURS = '48,24,8,2'; process.env.CASE_SLA_FROM = '2026-12-01T00:00:00Z';
		const r2 = (await e.call('GET', R, e.sa.id)).json.data; const by = (k: string) => r2.preconditions.find((p: any) => p.key === k);
		assert.equal(by('support_owner').met, true); assert.equal(by('support_perms').met, true); assert.equal(by('disputes_owner').met, true);
		assert.equal(by('disputes_perms').met, false); assert.match(by('disputes_perms').detail, /disputes\.resolve/);
		assert.equal(by('hours').met, true); assert.equal(by('start_date').met, true); assert.equal(r2.ready, false); assert.equal(r2.automaticEscalation, 'closed');
		assert.ok(!JSON.stringify(r2).includes(sup.user.id), 'assignee ids are not echoed');
		process.env.SUPPORT_SLA_FIRST_REPLY_HOURS = '48,24,8'; assert.equal((await svc.escalationReadiness()).preconditions.find(p => p.key === 'hours')!.met, false);
		assert.equal(process.env.CASE_SLA_ENABLED, undefined, 'reading the readiness never enables anything');
		for (const m of ['PUT', 'POST', 'PATCH', 'DELETE']) assert.equal((await e.call(m, R, e.sa.id, {})).status, 404, `${m} must not exist`);
		const on = await svc.escalationReadiness({ CASE_SLA_ENABLED: 'true' } as any); assert.equal(on.automaticEscalation, 'configured_on'); assert.equal(on.ready, false);
	} finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});
