import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL regression tests of the affiliate commission engine (createCommissionsForStageReleaseEvent) and of the numbers the marketer pages read.
 * Runs ONLY against the isolated throw-away database (QA_ISOLATED_PG_URL == DATABASE_URL on 127.0.0.1/localhost:55432); skipped otherwise. All data is synthetic.
 *
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_prc npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --test src/services/pg-affiliate-commission.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const engine = async () => import('./affiliate-commission.service');

const FLAG = 'AFFILIATE_COMMISSION_ENGINE_ENABLED';
const ALLOW = 'AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS';
/** Runs fn with the given env (undefined = unset), always restoring the previous values. */
async function withEnv<T>(env: { flag?: string; allow?: string }, fn: () => Promise<T>): Promise<T> {
	const prev = { f: process.env[FLAG], a: process.env[ALLOW] };
	const set = (k: string, v?: string) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
	set(FLAG, env.flag); set(ALLOW, env.allow);
	try { return await fn(); } finally { set(FLAG, prev.f); set(ALLOW, prev.a); }
}
const ON = { flag: 'true' };

async function mkUser(prisma: any, tag: string, kind: 'CLIENT' | 'PROVIDER' | 'AFFILIATE') {
	const accountType = kind === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : kind === 'PROVIDER' ? 'PROVIDER_INDIVIDUAL' : 'MARKETING_BROKER';
	const role = kind;
	return prisma.user.create({ data: { id: randomUUID(), accountType, firstName: 'QA', lastName: kind, email: `aff-${kind.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}@pg.test`, roles: [role], activeRole: role } });
}
async function mkAffiliate(prisma: any, tag: string, level = 1) {
	const user = await mkUser(prisma, tag, 'AFFILIATE');
	const profile = await prisma.affiliateProfile.create({ data: { userId: user.id, level } });
	return { user, profile };
}
async function mkReferral(prisma: any, affiliateId: string, referredUserId: string) {
	return prisma.referral.create({ data: { affiliateId, referredUserId } });
}

/** A contract with `amounts.length` stages; the client is referred by a fresh level-`level` affiliate (referral PENDING). */
async function seed(over: { amounts?: number[]; level?: number; referClient?: boolean; referProvider?: boolean } = {}) {
	const prisma = await db();
	const tag = randomUUID().slice(0, 8);
	const client = await mkUser(prisma, tag, 'CLIENT');
	const provider = await mkUser(prisma, tag, 'PROVIDER');
	const project = await prisma.project.create({ data: { id: randomUUID(), title: `QA commission ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const amounts = over.amounts ?? [250];
	const price = amounts.reduce((a, b) => a + b, 0);
	const contract = await prisma.contract.create({ data: { id: randomUUID(), projectId: project.id, clientId: client.id, providerId: provider.id, price, durationDays: 14, phasesCount: amounts.length, status: 'ACTIVE', signedAt: new Date() } });
	const stages: any[] = [];
	for (const [i, amount] of amounts.entries()) {
		stages.push(await prisma.projectStage.create({ data: { id: randomUUID(), contractId: contract.id, stepOrder: i + 1, title: `المرحلة ${i + 1}`, days: 5, percentage: Math.round((amount / price) * 10000) / 100, amount, status: 'SUBMITTED' } }));
	}
	const aff = await mkAffiliate(prisma, tag, over.level ?? 1);
	const referral = over.referClient === false ? null : await mkReferral(prisma, aff.profile.id, client.id);
	const providerAff = over.referProvider ? await mkAffiliate(prisma, tag) : null;
	const providerReferral = providerAff ? await mkReferral(prisma, providerAff.profile.id, provider.id) : null;
	const ctx = (i = 0) => ({ contract: { id: contract.id, projectId: project.id, clientId: client.id, providerId: provider.id }, stageId: stages[i].id, releasedAmount: stages[i].amount as number });
	return { prisma, tag, client, provider, project, contract, stages, aff, referral, providerAff, providerReferral, ctx };
}
type World = Awaited<ReturnType<typeof seed>>;

/** One release event in its own transaction; also writes a marker row AFTER the engine call to prove the surrounding transaction is still usable and commits. */
async function release(w: World, i = 0, marker = false) {
	const { createCommissionsForStageReleaseEvent } = await engine();
	return w.prisma.$transaction(async (tx: any) => {
		const created = await createCommissionsForStageReleaseEvent(tx, w.ctx(i));
		if (marker) await tx.project.update({ where: { id: w.project.id }, data: { description: `marker-${i}` } });
		return created;
	});
}
const rows = (w: World, extra: any = {}) => w.prisma.commissionLog.findMany({ where: { sourceProjectId: w.project.id, ...extra }, orderBy: { createdAt: 'asc' } });
const refStatus = async (w: World, id = w.referral?.id) => (await w.prisma.referral.findUnique({ where: { id } })).status;
const dispute = (w: World, status: string) => w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, status, reason: 'نزاع QA', description: 'نزاع اختباري' } });

test('(1) client-referral stage approval creates exactly ONE APPROVED commission with full snapshots and flips the referral to CONVERTED', opts, async () => {
	const w = await seed({ amounts: [250] });
	assert.equal(await refStatus(w), 'PENDING');
	const created = await withEnv(ON, () => release(w));
	assert.equal(created.length, 1);
	const all = await rows(w);
	assert.equal(all.length, 1);
	const c = all[0];
	assert.equal(c.status, 'APPROVED');
	assert.equal(c.type, 'STAGE_RELEASE');
	assert.equal(c.amount, 2.5); // 1% x 250
	assert.equal(c.baseAmount, 250);
	assert.equal(c.appliedPercentage, 1);
	assert.equal(c.level, 1);
	assert.equal(c.currency, 'USD');
	assert.equal(c.sourceProjectId, w.project.id);
	assert.equal(c.sourceStageId, w.stages[0].id);
	assert.equal(c.affiliateId, w.aff.profile.id);
	assert.equal(c.referralId, w.referral.id);
	assert.equal(c.referredUserId, w.client.id);
	assert.equal(created[0].commissionId, c.id);
	assert.equal(created[0].affiliateUserId, w.aff.user.id);
	assert.equal(await refStatus(w), 'CONVERTED');
});

test('(1b) the percentage follows the affiliate level and cents are rounded (level 1: 33.33 -> 0.33)', opts, async () => {
	const w = await seed({ amounts: [33.33] });
	await withEnv(ON, () => release(w));
	const [c] = await rows(w);
	assert.equal(c.amount, 0.33);
	assert.equal(c.baseAmount, 33.33);
});

test('(2a) replaying the same release event (engine call only) never throws and keeps ONE row and ONE flip', opts, async () => {
	const w = await seed({ amounts: [400] });
	assert.equal((await withEnv(ON, () => release(w))).length, 1);
	assert.equal((await withEnv(ON, () => release(w))).length, 0);
	await withEnv(ON, () => Promise.all(Array.from({ length: 10 }, () => release(w))));
	const all = await rows(w);
	assert.equal(all.length, 1);
	assert.equal(all[0].amount, 4);
	assert.equal(await refStatus(w), 'CONVERTED');
});

// (2) and (2b) below FAIL today: DEFECT. A replayed/duplicate commission insert raises P2002 INSIDE the caller's PostgreSQL transaction; the engine catches it and `continue`s,
// but PostgreSQL has already aborted the transaction (25P02), so ANY later statement of the surrounding transaction (e.g. the rest of reviewDelivery) throws
// "current transaction is aborted" and the whole approval rolls back. Kept as the minimal failing regression for the owner decision / fix.
test('(2) replaying the same release event twice (separate transactions) keeps ONE row and ONE flip, and does not throw or abort the surrounding transaction', opts, async () => {
	const w = await seed({ amounts: [400] });
	const first = await withEnv(ON, () => release(w, 0, true));
	assert.equal(first.length, 1);
	const updatedAtAfterFirst = (await w.prisma.referral.findUnique({ where: { id: w.referral.id } })).updatedAt.getTime();
	await w.prisma.project.update({ where: { id: w.project.id }, data: { description: 'reset' } });
	const second = await withEnv(ON, () => release(w, 0, true)); // must not throw
	assert.equal(second.length, 0, 'a replay reports no new commission');
	const all = await rows(w);
	assert.equal(all.length, 1);
	assert.equal(all[0].amount, 4);
	assert.equal((await w.prisma.referral.findUnique({ where: { id: w.referral.id } })).updatedAt.getTime(), updatedAtAfterFirst, 'no second flip');
	assert.equal((await w.prisma.project.findUnique({ where: { id: w.project.id } })).description, 'marker-0', 'the write AFTER the replayed engine call committed: the transaction was not aborted');
});

test('(2b) 10 concurrent release events for the same stage leave exactly ONE row, one creator, and every transaction commits its later writes', opts, async () => {
	const w = await seed({ amounts: [1000] });
	const results = await withEnv(ON, () => Promise.all(Array.from({ length: 10 }, () => release(w, 0, true))));
	assert.equal(results.filter(r => r.length === 1).length, 1, 'exactly one call created the commission');
	assert.equal(results.filter(r => r.length === 0).length, 9);
	const all = await rows(w);
	assert.equal(all.length, 1);
	assert.equal(all[0].amount, 10);
	assert.equal(await refStatus(w), 'CONVERTED');
	assert.equal((await w.prisma.project.findUnique({ where: { id: w.project.id } })).description, 'marker-0');
});

test('(3) a referred PROVIDER earns nothing; only the client referral earns', opts, async () => {
	const w = await seed({ amounts: [300], referProvider: true });
	await withEnv(ON, () => release(w));
	const all = await rows(w);
	assert.equal(all.length, 1);
	assert.equal(all[0].affiliateId, w.aff.profile.id);
	assert.equal(await w.prisma.commissionLog.count({ where: { affiliateId: w.providerAff!.profile.id } }), 0);
	assert.equal(await refStatus(w, w.providerReferral.id), 'PENDING');
});

test('(3b) a provider referral alone (client not referred) creates nothing', opts, async () => {
	const w = await seed({ amounts: [300], referClient: false, referProvider: true });
	const created = await withEnv(ON, () => release(w));
	assert.equal(created.length, 0);
	assert.equal((await rows(w)).length, 0);
	assert.equal(await refStatus(w, w.providerReferral.id), 'PENDING');
});

test('(3c) allowlist: unset = everyone earns; set without the referral = nobody; set with it = earns; set-but-empty = nobody; whitespace/comma lists work', opts, async () => {
	const other = await seed();
	const cases: Array<{ name: string; allow: (w: World) => string | undefined; earns: boolean }> = [
		{ name: 'unset', allow: () => undefined, earns: true },
		{ name: 'listed', allow: w => w.referral.id, earns: true },
		{ name: 'listed among others with spaces', allow: w => ` ${other.referral.id} , ${w.referral.id} ,`, earns: true },
		{ name: 'other referral only', allow: () => other.referral.id, earns: false },
		{ name: 'set but empty', allow: () => '', earns: false },
		{ name: 'only commas/blanks', allow: () => ' , ,', earns: false }
	];
	for (const c of cases) {
		const w = await seed({ amounts: [100] });
		const created = await withEnv({ flag: 'true', allow: c.allow(w) }, () => release(w));
		assert.equal((await rows(w)).length, c.earns ? 1 : 0, c.name);
		assert.equal(created.length, c.earns ? 1 : 0, c.name);
		assert.equal(await refStatus(w), c.earns ? 'CONVERTED' : 'PENDING', c.name);
	}
	// the listed other referral earns while a non-listed one in the same environment does not
	const a = await seed({ amounts: [100] });
	const b = await seed({ amounts: [100] });
	await withEnv({ flag: 'true', allow: a.referral.id }, async () => { await release(a); await release(b); });
	assert.equal((await rows(a)).length, 1);
	assert.equal((await rows(b)).length, 0);
});

test('(4) engine flag off (unset / false / "TRUE" / "1") = zero reads and zero writes', opts, async () => {
	const w = await seed({ amounts: [500] });
	const { createCommissionsForStageReleaseEvent } = await engine();
	for (const flag of [undefined, 'false', 'TRUE', '1', '']) {
		await withEnv({ flag }, async () => {
			const calls: string[] = [];
			const spy = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_t2, op: string) => () => { calls.push(`${model}.${op}`); throw new Error('engine touched the database while off'); } }) });
			const out = await createCommissionsForStageReleaseEvent(spy as any, w.ctx());
			assert.deepEqual(out, []);
			assert.deepEqual(calls, [], `flag=${String(flag)}`);
		});
	}
	await withEnv({ flag: undefined }, () => release(w));
	assert.equal((await rows(w)).length, 0);
	assert.equal(await refStatus(w), 'PENDING');
});

test('(5) an OPEN or UNDER_REVIEW dispute at release time skips; RESOLVED/REJECTED does not', opts, async () => {
	for (const status of ['OPEN', 'UNDER_REVIEW']) {
		const w = await seed({ amounts: [200] });
		await dispute(w, status);
		const created = await withEnv(ON, () => release(w));
		assert.equal(created.length, 0, status);
		assert.equal((await rows(w)).length, 0, status);
		assert.equal(await refStatus(w), 'PENDING', status);
	}
	for (const status of ['RESOLVED', 'REJECTED']) {
		const w = await seed({ amounts: [200] });
		await dispute(w, status);
		await withEnv(ON, () => release(w));
		const all = await rows(w);
		assert.equal(all.length, 1, status);
		assert.equal(all[0].amount, 2, status);
		assert.equal(await refStatus(w), 'CONVERTED', status);
	}
});

test('(5b) a dispute on ANOTHER project does not block this project', opts, async () => {
	const w = await seed({ amounts: [200] });
	const other = await seed({ amounts: [200] });
	await dispute(other, 'OPEN');
	await withEnv(ON, () => release(w));
	assert.equal((await rows(w)).length, 1);
});

test('(6) two stages of one contract give two commissions (one per stage), replays of either add nothing', opts, async () => {
	const w = await seed({ amounts: [100, 300] });
	await withEnv(ON, async () => { await release(w, 0); await release(w, 1); await release(w, 0); await release(w, 1); });
	const all = await rows(w);
	assert.equal(all.length, 2);
	const byStage = new Map(all.map((r: any) => [r.sourceStageId, r]));
	assert.equal(byStage.get(w.stages[0].id).amount, 1);
	assert.equal(byStage.get(w.stages[1].id).amount, 3);
	assert.equal(await refStatus(w), 'CONVERTED');
});

test('(6b) a second affiliate cannot refer the same client (Referral.referredUserId is unique) so the stage still pays exactly one commission', opts, async () => {
	const w = await seed({ amounts: [100] });
	const second = await mkAffiliate(w.prisma, w.tag, 1);
	await assert.rejects(() => mkReferral(w.prisma, second.profile.id, w.client.id), (e: any) => e.code === 'P2002');
	await withEnv(ON, () => release(w));
	assert.equal((await rows(w)).length, 1);
	assert.equal(await w.prisma.commissionLog.count({ where: { affiliateId: second.profile.id } }), 0);
});

test('(6c) the same stage amount across two different referred clients produces one commission each (independent referrals/affiliates)', opts, async () => {
	const a = await seed({ amounts: [100] });
	const b = await seed({ amounts: [100] });
	await withEnv(ON, async () => { await release(a); await release(b); });
	assert.equal((await rows(a)).length, 1);
	assert.equal((await rows(b)).length, 1);
	assert.notEqual((await rows(a))[0].affiliateId, (await rows(b))[0].affiliateId);
});

test('(6d) the dedup index is per (affiliate, referral, type, stage): a different TYPE for the same stage is a separate row, an identical key is refused', opts, async () => {
	const w = await seed({ amounts: [100] });
	await withEnv(ON, () => release(w));
	const base = { affiliateId: w.aff.profile.id, referralId: w.referral.id, referredUserId: w.client.id, sourceStageId: w.stages[0].id, baseAmount: 100, appliedPercentage: 1, level: 1, amount: 1, currency: 'USD', status: 'APPROVED' };
	await assert.rejects(() => w.prisma.commissionLog.create({ data: { ...base, type: 'STAGE_RELEASE' } }), (e: any) => e.code === 'P2002');
	await w.prisma.commissionLog.create({ data: { ...base, type: 'SUBSCRIPTION' } });
});

test('(7) marketer summary numbers and the withdrawable balance agree with the commission rows', opts, async () => {
	const w = await seed({ amounts: [100, 300, 600] });
	const { marketerOverviewService } = await import('./marketer-overview.service');
	await withEnv(ON, async () => { await release(w, 0); await release(w, 1); await release(w, 2); });
	// a PENDING and a PAID manual ledger row (no stage): counted in pending / paid, never as earned-approved, never as a "successful" proof
	const manual = { affiliateId: w.aff.profile.id, referralId: w.referral.id, referredUserId: w.client.id, baseAmount: 0, appliedPercentage: 0, level: 1, currency: 'USD', type: 'NEW_CLIENT_REQUEST' };
	await w.prisma.commissionLog.create({ data: { ...manual, amount: 7, status: 'PENDING' } });
	await w.prisma.commissionLog.create({ data: { ...manual, type: 'SUBSCRIPTION', amount: 5, status: 'PAID' } });
	const all = await w.prisma.commissionLog.findMany({ where: { affiliateId: w.aff.profile.id } });
	const sum = (st: string) => Math.round(all.filter((r: any) => r.status === st).reduce((a: number, r: any) => a + r.amount, 0) * 100) / 100;
	assert.equal(sum('APPROVED'), 10); // 1 + 3 + 6
	const s = await marketerOverviewService.getSummary(w.aff.user.id);
	assert.equal(s.approvedCommissions, sum('APPROVED'));
	assert.equal(s.pendingCommissions, sum('PENDING'));
	assert.equal(s.paidCommissions, sum('PAID'));
	assert.equal(s.totalCommissions, sum('APPROVED') + sum('PAID'));
	assert.equal(s.successfulReferrals, 1);
	assert.equal(s.totalReferrals, 1);
	// the withdrawal balance is the same APPROVED aggregate
	const agg = await w.prisma.commissionLog.aggregate({ where: { affiliateId: w.aff.profile.id, status: 'APPROVED' }, _sum: { amount: true } });
	assert.equal(agg._sum.amount, s.approvedCommissions);
});

test('(7b) a skipped release (engine off) leaves the marketer summary at zero', opts, async () => {
	const w = await seed({ amounts: [100] });
	const { marketerOverviewService } = await import('./marketer-overview.service');
	await withEnv({ flag: undefined }, () => release(w));
	const s = await marketerOverviewService.getSummary(w.aff.user.id);
	assert.equal(s.approvedCommissions, 0);
	assert.equal(s.totalCommissions, 0);
	assert.equal(s.successfulReferrals, 0);
	assert.equal(s.totalReferrals, 1);
});

test('(8) self-referral rows earn nothing', opts, async () => {
	const prisma = await db();
	const w = await seed({ amounts: [100], referClient: false });
	// the affiliate profile belongs to the contract client itself
	const profile = await prisma.affiliateProfile.create({ data: { userId: w.client.id, level: 1 } });
	const ref = await mkReferral(prisma, profile.id, w.client.id);
	const created = await withEnv(ON, () => release(w));
	assert.equal(created.length, 0);
	assert.equal((await rows(w)).length, 0);
	assert.equal(await refStatus(w, ref.id), 'PENDING');
});
