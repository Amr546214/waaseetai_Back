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
		assert.ok(['api', 'database', 'backup', 'cdn', 'infra'].includes(i.group)); assert.ok(['measured', 'unavailable', 'error'].includes(i.status));
		assert.ok(i.label && i.source && typeof i.unit === 'string'); assert.ok(Number.isFinite(Date.parse(i.readAt)), i.key);
		assert.ok(i.scope, `${i.key} must state its scope`);
		if (i.status === 'measured') assert.ok(typeof i.value === 'number' || i.valueText, i.key); else { assert.equal(i.value, null, i.key); assert.ok(i.reason, `${i.key} needs a reason`); }
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
	for (const k of ['backup_status', 'backup_last_success', 'backup_size', 'restore_status', 'restore_last_success']) { const i = get(r.json, k); assert.equal(i.status, 'unavailable', k); assert.match(i.reason, /مهمة النسخ|نسخة|اختبار/, k); }
	assert.equal(get(r.json, 'backup_status').state, 'NO_DATA');
	for (const k of ['cdn_storage', 'cdn_bandwidth', 'cdn_transformations', 'cdn_resources', 'cdn_hit_ratio', 'edge_requests', 'edge_hit_ratio', 'waf_blocked', 'host_cpu', 'ctr_running']) assert.equal(get(r.json, k).status, 'unavailable', k);
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
		assert.equal(r.assignees.support.state, 'MISSING'); assert.equal(r.rules.supportFirstReply.source, 'default'); assert.deepEqual(r.rules.supportFirstReply.hours, { low: 48, normal: 24, high: 8, urgent: 2 }); assert.equal(r.rules.disputes.hours, 168); assert.equal(r.decisions.length, 6); assert.ok(r.decisions.every((d: any) => d.status === 'open')); assert.equal(r.schedulerRunning, false);
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

test('deprecated /health items cdn/backup are derived from the SAME reading as technical-metrics (old and new consumers cannot disagree)', opts, async () => {
	const { e, svc, base } = await fresh();
	const health = async () => (await e.call('GET', '/admin/system-settings/health', e.sa.id)).json.data.items as any[];
	const item = (items: any[], k: string) => items.find(x => x.key === k);
	// not configured: unavailable + the same reason
	let m = (await e.call('GET', P, e.sa.id)).json; let h = await health();
	for (const [k, ik] of [['cdn', 'cdn_storage'], ['backup', 'backup_status']] as const) {
		assert.equal(item(h, k).deprecated, true); assert.equal(item(h, k).replacedBy, 'technical-metrics'); assert.equal(item(h, k).status, 'unavailable'); assert.equal(item(h, k).detail, get(m, ik).reason);
	}
	// measured: the health item carries the same value and the same readAt
	svc.reset(); svc.deps = { ...base, cdnConfigured: () => true, cdnUsage: async () => ({ storageBytes: 7 * 1048576, bandwidthBytes: null, transformations: null, resources: null, plan: null }) };
	m = (await e.call('GET', P, e.sa.id)).json; h = await health();
	assert.equal(item(h, 'cdn').status, 'ok'); assert.ok(item(h, 'cdn').detail.includes('7 MB')); assert.equal(item(h, 'cdn').readAt, get(m, 'cdn_storage').readAt);
	// provider failure: unavailable with the same reason, never ok
	svc.reset(); svc.deps = { ...base, cdnConfigured: () => true, cdnUsage: async () => { throw new Error('x'); } };
	m = (await e.call('GET', P, e.sa.id)).json; h = await health(); assert.equal(item(h, 'cdn').status, 'unavailable'); assert.equal(item(h, 'cdn').detail, get(m, 'cdn_storage').reason);
	assert.match(item(h, 'app').label, /هذه النسخة فقط/); assert.ok(item(h, 'database') && item(h, 'app') && !item(h, 'database').deprecated);
	svc.reset();
});

test('backup over HTTP: every state from the job status file reaches technical-metrics and the deprecated /health item with the same wording; no path or raw text leaks', opts, async () => {
	const { e, svc, base } = await fresh(); svc.deps = { ...base, cdnConfigured: () => false };
	const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const pth = await import('node:path');
	const dir = mkdtempSync(pth.join(tmpdir(), 'qa-iso-mon-bkh-')); const f = pth.join(dir, 'status.json'); const keep = process.env.BACKUP_STATUS_FILE;
	const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
	const run = async (o: unknown | null) => { svc.reset(); if (o !== null) writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); const m = (await e.call('GET', P, e.sa.id)).json; const h = (await e.call('GET', '/admin/system-settings/health', e.sa.id)).json.data.items.find((x: any) => x.key === 'backup'); return { m, h, text: JSON.stringify(m) + JSON.stringify(h) }; };
	try {
		process.env.BACKUP_STATUS_FILE = pth.join(dir, 'absent.json');
		let r = await run(null); assert.equal(get(r.m, 'backup_status').state, 'NO_DATA'); assert.equal(get(r.m, 'backup_status').status, 'unavailable'); assert.equal(r.h.status, 'unavailable');
		process.env.BACKUP_STATUS_FILE = f;
		r = await run({ schemaVersion: 1, lastAttemptAt: ago(3), lastAttemptOutcome: 'success', lastSuccessAt: ago(3), lastSuccessSizeBytes: 3 * 1048576, lastRestoreTestAt: ago(30), lastRestoreTestOutcome: 'pass', lastRestoreTestCheck: 'SCHEMA_OK' });
		assert.equal(get(r.m, 'backup_status').state, 'OK'); assert.equal(get(r.m, 'backup_status').status, 'measured'); assert.equal(get(r.m, 'backup_size').value, 3); assert.equal(get(r.m, 'backup_last_success').kind, 'datetime'); assert.ok(get(r.m, 'backup_age').value >= 2.9);
		assert.equal(get(r.m, 'restore_status').state, 'OK'); assert.equal(r.h.status, 'ok'); assert.ok(r.h.detail.includes(get(r.m, 'backup_status').valueText)); assert.equal(r.h.readAt, get(r.m, 'backup_status').readAt);
		r = await run({ schemaVersion: 1, lastAttemptAt: ago(50), lastAttemptOutcome: 'success', lastSuccessAt: ago(50) }); assert.equal(get(r.m, 'backup_status').state, 'STALE'); assert.equal(r.h.status, 'down'); assert.equal(get(r.m, 'restore_status').state, 'NO_DATA');
		r = await run({ schemaVersion: 1, lastAttemptAt: ago(1), lastAttemptOutcome: 'failure', lastFailureAt: ago(1), lastFailureCode: 'DISK_FULL', lastSuccessAt: ago(20) }); assert.equal(get(r.m, 'backup_status').state, 'LAST_ATTEMPT_FAILED'); assert.match(get(r.m, 'backup_status').detail, /امتلاء القرص/); assert.equal(r.h.status, 'down');
		r = await run('{corrupt'); assert.equal(get(r.m, 'backup_status').state, 'UNREADABLE'); assert.equal(r.h.status, 'unavailable'); assert.equal(get(r.m, 'backup_last_success').status, 'unavailable');
		for (const leak of [dir, 'status.json', 'corrupt']) assert.ok(!r.text.includes(leak), leak);
	} finally { if (keep === undefined) delete process.env.BACKUP_STATUS_FILE; else process.env.BACKUP_STATUS_FILE = keep; rmSync(dir, { recursive: true, force: true }); svc.reset(); }
});

test('nothing spawns a process: the monitoring modules do not import child_process, and no code (except the documented script) can start a backup or set CASE_SLA_ENABLED', opts, async () => {
	const { readFileSync, readdirSync, statSync } = await import('node:fs'); const pth = await import('node:path');
	for (const f of ['backup-status.ts', 'infra-sources.ts', 'technical-monitoring.service.ts', 'request-metrics.ts']) assert.ok(!/child_process|execSync|execFile|spawn\(/.test(readFileSync(pth.join(__dirname, f), 'utf8')), f);
	const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = pth.join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []; });
	for (const p of walk(pth.join(__dirname, '..'))) assert.ok(!/CASE_SLA_ENABLED\s*=[^=]/.test(readFileSync(p, 'utf8')) && !/env\.CASE_SLA_ENABLED\s*=[^=]/.test(readFileSync(p, 'utf8')), p);
	assert.equal(process.env.CASE_SLA_ENABLED, undefined);
});

test('escalation readiness: each assignee state is reported precisely without echoing ids or emails; defaults vs explicit hours; invalid hours are flagged', opts, async () => {
	const { e, svc } = await fresh();
	const keep = { ...process.env }; for (const k of ['CASE_SLA_ENABLED', 'CASE_SLA_FROM', 'SUPPORT_SLA_FIRST_REPLY_HOURS', 'SUPPORT_SLA_TARGET_ADMIN_ID', 'DISPUTE_SLA_TARGET_ADMIN_ID']) delete process.env[k];
	try {
		const read = async () => (await e.call('GET', R, e.sa.id)).json.data;
		const full = await mkStaff(e, ['support.review', 'support.reply', 'disputes.view', 'disputes.resolve'], 'full');
		const partial = await mkStaff(e, ['support.review'], 'partial');
		const susp = await mkStaff(e, ['support.review', 'support.reply'], 'susp'); await e.prisma.adminStaff.update({ where: { userId: susp.user.id }, data: { status: 'SUSPENDED' } });
		const inactive = await mkStaff(e, ['support.review', 'support.reply'], 'inact'); await e.prisma.user.update({ where: { id: inactive.user.id }, data: { status: 'SUSPENDED' } });
		const client = await e.mkUser('CLIENT_INDIVIDUAL', 'cl'); const bare = await e.mkUser('ADMIN', 'bare');
		const cases: Array<[string, string, string?]> = [[full.user.id, 'ELIGIBLE'], [partial.user.id, 'LACKS_PERMISSION', 'support.reply'], [susp.user.id, 'STAFF_INACTIVE'], [inactive.user.id, 'INACTIVE'], [client.id, 'NOT_STAFF'], [bare.id, 'NOT_STAFF'], ['00000000-0000-0000-0000-000000000000', 'NOT_FOUND'], [e.sa.id, 'ELIGIBLE']];
		for (const [id, state, perm] of cases) {
			process.env.SUPPORT_SLA_TARGET_ADMIN_ID = id; const r = await read();
			assert.equal(r.assignees.support.state, state, state); if (perm) { assert.match(r.assignees.support.reason, new RegExp(perm.replace('.', '\\.'))); assert.deepEqual(r.assignees.support.missingPermissions, [perm]); }
			const txt = JSON.stringify(r); assert.ok(!txt.includes(id), 'no id echoed'); for (const u of [full.user, partial.user, susp.user, inactive.user, client, bare]) assert.ok(!txt.includes(u.email), 'no e-mail echoed');
		}
		process.env.DISPUTE_SLA_TARGET_ADMIN_ID = partial.user.id; const d = await read(); assert.equal(d.assignees.disputes.state, 'LACKS_PERMISSION'); assert.deepEqual(d.assignees.disputes.missingPermissions, ['disputes.view', 'disputes.resolve']);
		assert.equal(d.rules.supportFirstReply.source, 'default'); assert.match(d.rules.supportFirstReply.note, /الافتراضية/);
		process.env.SUPPORT_SLA_FIRST_REPLY_HOURS = '72,36,12,4'; let x = await read(); assert.equal(x.rules.supportFirstReply.source, 'explicit'); assert.deepEqual(x.rules.supportFirstReply.hours, { low: 72, normal: 36, high: 12, urgent: 4 });
		process.env.SUPPORT_SLA_FIRST_REPLY_HOURS = '0,1,1,1'; x = await read(); assert.equal(x.rules.supportFirstReply.source, 'invalid'); assert.equal(x.preconditions.find((p: any) => p.key === 'hours').met, false);
		process.env.CASE_SLA_FROM = '2026-12-01T00:00:00Z'; x = await read(); assert.equal(x.startDate.utc, '2026-12-01T00:00:00.000Z'); process.env.CASE_SLA_FROM = '2026-12-01'; assert.equal((await read()).startDate.valid, false);
		assert.equal(x.rules.disputes.hours, 168); assert.equal(x.rules.disputes.fixed, true); assert.equal(x.automaticEscalation, 'closed'); assert.match(x.statement, /لا يُسند/);
		assert.deepEqual(x.decisions.map((q: any) => q.key), ['support_assignee', 'disputes_assignee', 'hours', 'start_date', 'disputes_168', 'open_at_all']);
		assert.equal(x.schedulerRunning, false); assert.equal(process.env.CASE_SLA_ENABLED, undefined);
		for (const m of ['PUT', 'POST', 'PATCH', 'DELETE']) assert.equal((await e.call(m, R, e.sa.id, {})).status, 404);
		assert.equal(await e.prisma.accountAuditLog.count({ where: { eventType: { in: ['TICKET_ASSIGNED', 'DISPUTE_ASSIGNED'] } } }), 0, 'reading the screen assigned nothing');
		void svc;
	} finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});

test('payload states scope for every indicator and labels the instance (no aggregation across instances is claimed)', opts, async () => {
	const { e, svc, base } = await fresh(); svc.deps = { ...base, cdnConfigured: () => false };
	const j = (await e.call('GET', P, e.sa.id)).json.data;
	assert.match(j.instance.id, /^[0-9a-f]{6}$/); assert.match(j.instance.note, /النسخة وحدها|هذه النسخة/);
	for (const i of j.indicators) assert.ok(i.scope && i.scope.length > 5, i.key);
	assert.match(get({ data: j }, 'api_p95').scope, /نسخة واحدة/); assert.match(get({ data: j }, 'ctr_mem_used').scope, /حاوية/);
	assert.ok(!JSON.stringify(j).includes(require('node:os').hostname()), 'host name is never exposed');
});
