import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';
import { baselineFeePolicyPayload, BASELINE_FEE_POLICY_ID } from '../config/fee-policy.schema';
import { PROVIDER_LEVELS } from '../config/levels.config';

/** Versioned financial terms on REAL PostgreSQL over HTTP: permissions, validation, scheduling, immutability, audit, and "new operations follow the new version, existing ones keep theirs". */
after(closeEnv);
const F = '/admin/fee-policy';
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const reset = async (e: any) => { await e.prisma.feePolicyVersion.deleteMany({}); const { feePolicyService } = await import('./fee-policy.service'); feePolicyService.invalidate(); };
const view = async (e: any, who: string) => (await e.call('GET', F, who)).json.data;
const schedule = (e: any, who: string, body: any) => e.call('POST', F, who, body);
/** time passing: a scheduled version "takes effect" by moving its effectiveFrom to the past (versions are otherwise immutable) */
const takeEffect = async (e: any, id: string) => { await e.prisma.feePolicyVersion.update({ where: { id }, data: { effectiveFrom: new Date(Date.now() - 1000) } }); (await import('./fee-policy.service')).feePolicyService.invalidate(); };

test('PG fee policy: the baseline is today\'s constants; only fees.view reads, only fees.manage (or SUPER_ADMIN) schedules; a staff member without them is refused', opts, async () => {
	const e = await env(); await reset(e); const none = await mkStaff(e, ['users.view'], 'fn'), viewer = await mkStaff(e, ['fees.view'], 'fv'), manager = await mkStaff(e, ['fees.manage'], 'fm');
	assert.equal((await e.call('GET', F, none.user.id)).status, 403); assert.equal((await e.call('GET', F, null)).status, 401);
	const v = await view(e, viewer.user.id); assert.equal(v.active.version, 1); assert.equal(v.active.state, 'EFFECTIVE'); assert.deepEqual(v.active.payload, baselineFeePolicyPayload()); assert.equal(v.active.id, BASELINE_FEE_POLICY_ID);
	assert.deepEqual(v.active.payload.providerCommissionByLevel, PROVIDER_LEVELS.map(d => d.percent)); assert.equal(v.active.payload.minMarketerPayout, 300); assert.equal(v.active.payload.minProviderPayout, 0);
	const body = { changes: { minProviderPayout: 50 }, effectiveFrom: soon(60), note: 'اختبار', baseVersion: 1, confirmSensitive: true };
	assert.equal((await schedule(e, viewer.user.id, body)).status, 403, 'reading is not scheduling'); assert.equal((await schedule(e, none.user.id, body)).status, 403);
	assert.equal((await e.call('POST', `${F}/${randomUUID()}/cancel`, viewer.user.id)).status, 403);
	const r = await schedule(e, manager.user.id, body); assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.data.version, 2);
	assert.equal((await view(e, e.sa.id)).active.version, 1, 'scheduled, not yet in force');
});

test('PG fee policy: validation - safe ranges, a higher level is never worse, lead time, reason, version check, explicit confirmation, one pending version at a time, nothing is stored on a refusal', opts, async () => {
	const e = await env(); await reset(e); const ok = { changes: { minProviderPayout: 25 }, effectiveFrom: soon(60), note: 'سبب', baseVersion: 1, confirmSensitive: true };
	const rows = () => e.prisma.feePolicyVersion.count();
	const bad = async (patch: any, label: string, status = 400) => { const before = await rows(); const r = await schedule(e, e.sa.id, { ...ok, ...patch }); assert.equal(r.status, status, `${label}: ${JSON.stringify(r.json).slice(0, 200)}`); assert.equal(await rows(), before, `${label}: nothing stored`); return r; };
	await bad({ effectiveFrom: soon(5) }, 'too soon'); await bad({ effectiveFrom: new Date(Date.now() - 3600_000).toISOString() }, 'in the past'); await bad({ effectiveFrom: soon(60 * 24 * 400) }, 'too far'); await bad({ effectiveFrom: 'x' }, 'not a date'); await bad({ note: '  ' }, 'no reason');
	await bad({ changes: {} }, 'no changes'); await bad({ changes: { unknownField: 1 } }, 'unknown field'); await bad({ changes: { minMarketerPayout: -1 } }, 'negative min'); await bad({ changes: { minMarketerPayout: 99999 } }, 'huge min');
	await bad({ changes: { providerCommissionByLevel: [...baselineFeePolicyPayload().providerCommissionByLevel.slice(0, 14)] } }, '14 levels'); await bad({ changes: { providerCommissionByLevel: baselineFeePolicyPayload().providerCommissionByLevel.map((v, i) => (i === 3 ? 20 : v)) } }, 'provider commission rising with the level');
	await bad({ changes: { providerCommissionByLevel: baselineFeePolicyPayload().providerCommissionByLevel.map(() => 30) } }, 'above the safe range'); await bad({ changes: { clientCashbackByLevel: baselineFeePolicyPayload().clientCashbackByLevel.map((v, i) => (i === 5 ? 0.1 : v)) } }, 'cashback falling with the level');
	await bad({ changes: { depositFeePercent: { paypal: 7 } } }, 'incomplete method table'); await bad({ changes: { minProviderPayout: 10.123 === 1 ? 1 : 25, depositFeePercent: { ...baselineFeePolicyPayload().depositFeePercent, paypal: 7.123 } } }, 'three decimals'); await bad({ extra: 1 }, 'unknown body field');
	await bad({ baseVersion: 7 }, 'stale base version', 409); await bad({ confirmSensitive: false }, 'confirmation missing', 409);
	const refused = await schedule(e, e.sa.id, { ...ok, confirmSensitive: undefined }); assert.equal(refused.json.code, 'FEE_POLICY_CONFIRMATION_REQUIRED'); assert.deepEqual(refused.json.errors[0].diff, [{ path: 'minProviderPayout', from: 0, to: 25 }], 'the confirmation names exactly what changes');
	assert.equal((await schedule(e, e.sa.id, ok)).status, 201);
	await bad({ baseVersion: 2, changes: { minProviderPayout: 30 } }, 'a version is already pending', 409);
	await bad({ baseVersion: 1, changes: { minProviderPayout: 25 } }, 'old base version', 409);
});

test('PG fee policy: versions are immutable and auditable - cancel only before it takes effect, never the baseline, never an effective one; every change leaves an audit row with the diff, actor and address', opts, async () => {
	const e = await env(); await reset(e); const r = await schedule(e, e.sa.id, { changes: { depositFeePercent: { ...baselineFeePolicyPayload().depositFeePercent, paypal: 6 } }, effectiveFrom: soon(60), note: 'تخفيض رسوم الإيداع', baseVersion: 1, confirmSensitive: true }); assert.equal(r.status, 201);
	const a = await e.prisma.accountAuditLog.findFirstOrThrow({ where: { eventType: 'FEE_POLICY_SCHEDULED', userId: e.sa.id }, orderBy: { occurredAt: 'desc' } }); assert.deepEqual(a.beforeData, { 'depositFeePercent.paypal': 7 }); assert.deepEqual(a.afterData, { 'depositFeePercent.paypal': 6 }); assert.ok(a.ipAddress); assert.equal(a.severity, 'WARNING'); assert.equal((a.metaData as any).note, 'تخفيض رسوم الإيداع');
	const id = r.json.data.id; const hist = (await view(e, e.sa.id)); assert.equal(hist.upcoming.length, 1); assert.equal(hist.history[0].state, 'SCHEDULED');
	assert.equal((await e.call('POST', `${F}/${BASELINE_FEE_POLICY_ID}/cancel`, e.sa.id)).status, 409);
	assert.equal((await e.call('POST', `${F}/${id}/cancel`, e.sa.id)).status, 200); assert.equal((await view(e, e.sa.id)).upcoming.length, 0); assert.equal((await e.call('POST', `${F}/${id}/cancel`, e.sa.id)).status, 409, 'already cancelled'); assert.equal(await e.prisma.accountAuditLog.count({ where: { eventType: 'FEE_POLICY_CANCELLED' } }) >= 1, true);
	assert.equal((await e.call('POST', `${F}/${randomUUID()}/cancel`, e.sa.id)).status, 404);
	const r2 = await schedule(e, e.sa.id, { changes: { minMarketerPayout: 400 }, effectiveFrom: soon(60), note: 'رفع الحد', baseVersion: 1, confirmSensitive: true }); assert.equal(r2.status, 201, 'the cancelled version never blocks a new one'); await takeEffect(e, r2.json.data.id);
	assert.equal((await e.call('POST', `${F}/${r2.json.data.id}/cancel`, e.sa.id)).status, 409, 'an effective version is history');
	const v = await view(e, e.sa.id); assert.equal(v.active.payload.minMarketerPayout, 400); assert.equal(v.active.version, 3); assert.equal(v.history.find((h: any) => h.version === 2).state, 'CANCELLED');
	// immutability: the API has no edit route at all
	for (const m of ['PUT', 'PATCH', 'DELETE'] as const) assert.ok([404, 405].includes((await e.call(m, `${F}/${r2.json.data.id}`, e.sa.id, {})).status), m);
});

test('PG fee policy: NEW operations follow the version in force, EXISTING ones keep theirs - escrow commission snapshot, PayPal deposit quote, marketer commission table, withdrawal minimum; GET /levels shows what is in force', opts, async () => {
	const e = await env(); await reset(e); const { feePolicyService } = await import('./fee-policy.service'); const { buildEscrowSnapshotFromPolicy, splitRelease } = await import('../utils/escrow-commission'); const { calculateAffiliateCommission } = await import('./affiliate-commission.service'); const { getLevelsTable } = await import('../controllers/gamification.controller');
	const p1 = await feePolicyService.active(); assert.equal(p1.version, 1);
	const escrowOld = buildEscrowSnapshotFromPolicy(3, p1); assert.equal(escrowOld.providerCommissionRateSnapshot, 12.1); assert.equal(escrowOld.feePolicyId, BASELINE_FEE_POLICY_ID);
	const higher = baselineFeePolicyPayload(); const r = await schedule(e, e.sa.id, { changes: { providerCommissionByLevel: higher.providerCommissionByLevel.map(v => v - 1), marketerCommissionByLevel: higher.marketerCommissionByLevel.map(v => v + 0.5), depositFeePercent: { ...higher.depositFeePercent, paypal: 6 }, minMarketerPayout: 500, minProviderPayout: 20 }, effectiveFrom: soon(60), note: 'سياسة جديدة', baseVersion: 1, confirmSensitive: true }); assert.equal(r.status, 201, JSON.stringify(r.json));
	assert.equal((await feePolicyService.active()).version, 1, 'not yet in force'); assert.equal((await feePolicyService.active(new Date(Date.now() + 2 * 3600_000))).version, 2, 'in force from its effective time');
	await takeEffect(e, r.json.data.id); const p2 = await feePolicyService.active(); assert.equal(p2.version, 2);
	const escrowNew = buildEscrowSnapshotFromPolicy(3, p2); assert.equal(escrowNew.providerCommissionRateSnapshot, 11.1); assert.equal(escrowNew.feePolicyId, p2.id);
	// the OLD escrow keeps its frozen rate: its release split is unchanged by the new version
	const oldSplit = splitRelease({ grossReleasedBefore: 0, commissionTotalBefore: 0, grossReleasedAfter: 1000, ratePercent: escrowOld.providerCommissionRateSnapshot }); assert.equal(oldSplit.commission, 121); assert.equal(splitRelease({ grossReleasedBefore: 0, commissionTotalBefore: 0, grossReleasedAfter: 1000, ratePercent: escrowNew.providerCommissionRateSnapshot }).commission, 111);
	// marketer commission follows the table of the version the escrow was locked under; a NULL / baseline id still means today's table
	const oldLadder = (await feePolicyService.byId(null)).payload.marketerCommissionByLevel; const newLadder = (await feePolicyService.byId(p2.id)).payload.marketerCommissionByLevel;
	assert.equal(calculateAffiliateCommission(3, 1000, oldLadder).percentage, 1.5); assert.equal(calculateAffiliateCommission(3, 1000, newLadder).percentage, 2); assert.equal(calculateAffiliateCommission(3, 1000).percentage, 1.5);
	assert.equal((await feePolicyService.byId(BASELINE_FEE_POLICY_ID)).version, 1); assert.equal((await feePolicyService.byId(randomUUID())).version, 1, 'an unknown id never invents terms: baseline');
	// PayPal deposit: the quote under each version is stored on the payment with the policy id; the earlier PENDING payment is untouched
	const { paypalFinanceService } = await import('./paypal-finance.service'); const { paypalService } = await import('./paypal.service'); (paypalService as any).createOrder = async () => ({ id: `ORD-${randomUUID().slice(0, 8)}` });
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'dep'); const q2 = await paypalFinanceService.initiateDeposit(client.id, 100); assert.equal(q2.feePercent, 6); assert.equal(q2.grossAmount, 106.38);
	const row = await e.prisma.paypalPayment.findFirstOrThrow({ where: { userId: client.id } }); assert.equal(row.feePolicyId, p2.id); assert.equal(Number(row.feePercent), 6);
	await e.prisma.feePolicyVersion.update({ where: { id: p2.id }, data: { cancelledAt: new Date() } }); feePolicyService.invalidate(); const q1 = await paypalFinanceService.initiateDeposit(client.id, 100); assert.equal(q1.feePercent, 7); assert.equal(q1.grossAmount, 107.53, 'cancelling the newer version returns to the earlier terms for new quotes only');
	assert.equal(Number((await e.prisma.paypalPayment.findFirstOrThrow({ where: { id: row.id } })).feePercent), 6, 'the quote already stored never changes');
	await e.prisma.feePolicyVersion.update({ where: { id: p2.id }, data: { cancelledAt: null } }); feePolicyService.invalidate();
	// GET /levels shows the percentages in force and the minimum payouts
	const out: any = {}; await getLevelsTable({} as any, { json: (b: any) => Object.assign(out, b), status: () => ({ json: (b: any) => Object.assign(out, b) }) } as any);
	assert.equal(out.data.roles.PROVIDER.levels[2].percent, 11.1); assert.equal(out.data.roles.MARKETER.levels[2].percent, 2); assert.equal(out.data.payments.clientDeposit.paypal, 6); assert.equal(out.data.payments.minMarketerPayout, 500); assert.equal(out.data.feePolicy.version, 2);
});

test('PG fee policy: an unreadable store never breaks money paths - the last known good versions apply, a cold start falls back to the baseline built from today\'s constants', opts, async () => {
	const e = await env(); await reset(e); const { FeePolicyService } = await import('./fee-policy.service');
	let down = false; const flaky = new Proxy(e.prisma, { get: (t: any, k: string) => (k === 'feePolicyVersion' && down ? { findMany: async () => { throw new Error('connection lost'); } } : t[k]) });
	const r = await schedule(e, e.sa.id, { changes: { minMarketerPayout: 450 }, effectiveFrom: soon(60), note: 'x', baseVersion: 1, confirmSensitive: true }); await takeEffect(e, r.json.data.id);
	const svc = new FeePolicyService(flaky as any); assert.equal((await svc.active()).payload.minMarketerPayout, 450);
	down = true; svc.invalidate(); (svc as any).cache = null; assert.equal((await svc.active()).payload.minMarketerPayout, 450, 'last known good');
	const cold = new FeePolicyService(flaky as any); assert.deepEqual((await cold.active()).payload, baselineFeePolicyPayload(), 'cold start without a readable store = the baseline');
	await reset(e);
});
