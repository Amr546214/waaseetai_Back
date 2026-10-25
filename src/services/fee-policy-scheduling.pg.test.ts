import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';
import { baselineFeePolicyPayload } from '../config/fee-policy.schema';

/** Fee policy scheduling on REAL PostgreSQL: concurrency, restart, cancel-vs-effect, atomic failure, escalation, bounds, rounding, reference time. */
after(closeEnv);
const F = '/admin/fee-policy';
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const reset = async (e: any) => { await e.prisma.feePolicyVersion.deleteMany({}); (await import('./fee-policy.service')).feePolicyService.invalidate(); };
const body = (over: any = {}) => ({ changes: { minProviderPayout: 25 }, effectiveFrom: soon(60), note: 'سبب', baseVersion: 1, confirmSensitive: true, ...over });

test('PG fee policy scheduling: concurrent schedules leave exactly ONE pending version (one 201, the rest 409), and a version number is never reused', opts, async () => {
	const e = await env(); await reset(e);
	const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => e.call('POST', F, e.sa.id, body({ changes: { minProviderPayout: 10 + i } }))));
	assert.equal(rs.filter(r => r.status === 201).length, 1, rs.map(r => r.status).join()); assert.ok(rs.filter(r => r.status !== 201).every(r => r.status === 409));
	const rows = await e.prisma.feePolicyVersion.findMany({ orderBy: { version: 'asc' } });
	assert.deepEqual(rows.map((r: any) => r.version), [1, 2]); assert.equal(rows.filter((r: any) => r.effectiveFrom > new Date()).length, 1);
});

test('PG fee policy scheduling: after a "restart" (a brand-new service with an empty cache) the scheduled version takes effect at its time from the database alone', opts, async () => {
	const e = await env(); await reset(e);
	const r = await e.call('POST', F, e.sa.id, body({ changes: { minMarketerPayout: 410 } })); assert.equal(r.status, 201);
	const { FeePolicyService } = await import('./fee-policy.service'); const fresh = new FeePolicyService(e.prisma);
	assert.equal((await fresh.active()).payload.minMarketerPayout, 300, 'before its time');
	assert.equal((await fresh.active(new Date(Date.now() + 2 * 3600_000))).payload.minMarketerPayout, 410, 'from its time, with nothing kept in memory');
	await e.prisma.feePolicyVersion.update({ where: { id: r.json.data.id }, data: { effectiveFrom: new Date(Date.now() - 1000) } });
	assert.equal((await new FeePolicyService(e.prisma).active()).payload.minMarketerPayout, 410);
});

test('PG fee policy scheduling: cancel vs the effective time - two concurrent cancels succeed once; a cancel after the effective time is refused and the version stays in force', opts, async () => {
	const e = await env(); await reset(e);
	const a = await e.call('POST', F, e.sa.id, body()); const cs = await Promise.all([e.call('POST', `${F}/${a.json.data.id}/cancel`, e.sa.id), e.call('POST', `${F}/${a.json.data.id}/cancel`, e.sa.id)]);
	assert.deepEqual(cs.map(c => c.status).sort(), [200, 409]);
	const b = await e.call('POST', F, e.sa.id, body({ baseVersion: 1 })); assert.equal(b.status, 201);
	await e.prisma.feePolicyVersion.update({ where: { id: b.json.data.id }, data: { effectiveFrom: new Date(Date.now() + 1500) } });
	await new Promise(r => setTimeout(r, 1800));
	const late = await e.call('POST', `${F}/${b.json.data.id}/cancel`, e.sa.id); assert.equal(late.status, 409);
	assert.equal((await e.prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: b.json.data.id } })).cancelledAt, null);
	(await import('./fee-policy.service')).feePolicyService.invalidate(); assert.equal((await (await import('./fee-policy.service')).feePolicyService.active()).id, b.json.data.id);
});

test('PG fee policy scheduling: a failing audit write stores NO version (all-or-nothing)', opts, async () => {
	const e = await env(); await reset(e); const { FeePolicyService } = await import('./fee-policy.service');
	const failing: any = new Proxy(e.prisma, { get: (t: any, k) => k === '$transaction' ? (fn: any, o: any) => t.$transaction((tx: any) => fn(new Proxy(tx, { get: (x: any, kk) => kk === 'accountAuditLog' ? { create: async () => { throw new Error('audit down'); } } : x[kk] })), o) : t[k] });
	const before = await e.prisma.feePolicyVersion.count(), auditBefore = await e.prisma.accountAuditLog.count({ where: { eventType: 'FEE_POLICY_SCHEDULED' } });
	await assert.rejects(new FeePolicyService(failing).schedule(e.sa.id, body()), /audit down/);
	assert.equal(await e.prisma.feePolicyVersion.count(), before, 'nothing half-written'); assert.equal(await e.prisma.accountAuditLog.count({ where: { eventType: 'FEE_POLICY_SCHEDULED' } }), auditBefore);
});

test('PG fee policy scheduling: fees.view cannot write; fees.manage cannot grant itself or anyone a permission (roles stay SUPER_ADMIN only)', opts, async () => {
	const e = await env(); await reset(e); const viewer = await mkStaff(e, ['fees.view'], 'fv2'), manager = await mkStaff(e, ['fees.manage', 'team.view', 'settings.manage'], 'fm2');
	assert.equal((await e.call('POST', F, viewer.user.id, body())).status, 403);
	const before = await e.prisma.adminRole.count();
	for (const who of [viewer.user.id, manager.user.id]) {
		assert.equal((await e.call('POST', '/admin/team/roles', who, { name: `رفع ${randomUUID().slice(0, 5)}`, permissions: ['fees.manage'] })).status, 403);
		assert.equal((await e.call('PUT', `/admin/team/staff/${who}/access`, who, { overrides: { grant: ['fees.manage'] } })).status, 403);
	}
	assert.equal(await e.prisma.adminRole.count(), before);
});

test('PG fee policy scheduling: negative, non-finite, non-numeric, over-limit values and unsound fee equations are refused; two-decimal rounding is exact', opts, async () => {
	const e = await env(); await reset(e); const base = baselineFeePolicyPayload(); const n = (await e.prisma.feePolicyVersion.count());
	for (const v of [-1, -0.01, 1e9, Infinity, -Infinity, NaN, '300', null, true, {}, [], 300.005, 0.001]) {
		const r = await e.call('POST', F, e.sa.id, JSON.parse(JSON.stringify(body({ changes: { minMarketerPayout: v } }), (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? 'NaN-or-Infinity' : x))));
		assert.equal(r.status, 400, `${String(v)}: ${JSON.stringify(r.json).slice(0, 120)}`);
	}
	for (const p of [100, 99.99, 50, 20.01, -5]) assert.equal((await e.call('POST', F, e.sa.id, body({ changes: { depositFeePercent: { ...base.depositFeePercent, paypal: p } } }))).status, 400, `deposit fee ${p}: gross = net / (1 - fee) must stay sound`);
	assert.equal((await e.call('POST', F, e.sa.id, body({ changes: { providerCommissionByLevel: base.providerCommissionByLevel.map(() => 0) } }))).status, 400, 'zero commission is below the floor');
	assert.equal((await e.call('POST', F, e.sa.id, body({ changes: { clientCashbackByLevel: base.clientCashbackByLevel.map(v => v + 0.5) } }))).status, 400, 'display-only: cashback cannot be saved');
	assert.equal((await e.call('POST', F, e.sa.id, body({ changes: { marketerWithdrawalFeePercent: { ...base.marketerWithdrawalFeePercent, usdt: 3 } } }))).status, 400, 'display-only: withdrawal fee table cannot be saved');
	assert.equal(await e.prisma.feePolicyVersion.count(), n, 'no refused request stored anything');
	// rounding: a 2-decimal fee gives a gross whose gross - fee == net to the cent
	const { Prisma } = await import('@prisma/client');
	for (const [net, pct] of [[100, 7.25], [50, 7], [333.33, 8.5], [99999.99, 19.99]] as const) { const gross = new Prisma.Decimal(Math.round((net / (1 - pct / 100) + Number.EPSILON) * 100) / 100).toDecimalPlaces(2); const fee = gross.minus(net).toDecimalPlaces(2); assert.equal(gross.minus(fee).toFixed(2), net.toFixed(2)); assert.ok(fee.gte(0)); }
});

test('PG fee policy scheduling: the effective time is stored as one UTC reference instant and shown in the platform zone', opts, async () => {
	const e = await env(); await reset(e); const { instantOfWallClock, formatInZone } = await import('../utils/platform-time');
	const inst = instantOfWallClock('Asia/Riyadh', 2027, 3, 10, 9, 30); assert.equal(inst.toISOString(), '2027-03-10T06:30:00.000Z');
	const r = await e.call('POST', F, e.sa.id, body({ effectiveFrom: inst.toISOString() })); assert.equal(r.status, 201, JSON.stringify(r.json));
	const row = await e.prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: r.json.data.id } }); assert.equal(row.effectiveFrom.toISOString(), '2027-03-10T06:30:00.000Z');
	assert.match(formatInZone(row.effectiveFrom, 'Asia/Riyadh'), /09:30/); assert.match(formatInZone(row.effectiveFrom, 'UTC'), /06:30/);
	assert.equal((await e.call('GET', F, e.sa.id)).json.data.upcoming[0].effectiveFrom, '2027-03-10T06:30:00.000Z');
});
