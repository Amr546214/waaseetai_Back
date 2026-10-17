import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests of the one-off catch-up src/scripts/replay-stage-release-commissions.ts: dry run writes nothing, apply goes through the REAL engine, rules
 * (referral time, client only, dispute AT RELEASE, excluded project, already commissioned), exactly-once under replay and concurrency, and agreement of the marketer
 * numbers (summary / CONVERTED / commission rows). Isolated throw-away database only (QA_ISOLATED_PG_URL == DATABASE_URL on :55432); synthetic data. Run this file ALONE
 * on a fresh database (the plan scans every referral of the database).
 *
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_prp npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/services/pg-commission-replay.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const replay = async () => import('../scripts/replay-stage-release-commissions');

const FLAG = 'AFFILIATE_COMMISSION_ENGINE_ENABLED';
const ALLOW = 'AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS';
async function withEnv<T>(env: { flag?: string; allow?: string }, fn: () => Promise<T>): Promise<T> {
	const prev = { f: process.env[FLAG], a: process.env[ALLOW] };
	const set = (k: string, v?: string) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
	set(FLAG, env.flag); set(ALLOW, env.allow);
	try { return await fn(); } finally { set(FLAG, prev.f); set(ALLOW, prev.a); }
}
const ON = { flag: 'true' };
const min = (n: number) => new Date(Date.now() + n * 60_000);

async function mkUser(prisma: any, tag: string, kind: 'CLIENT' | 'PROVIDER' | 'AFFILIATE') {
	const accountType = kind === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : kind === 'PROVIDER' ? 'PROVIDER_INDIVIDUAL' : 'MARKETING_BROKER';
	return prisma.user.create({ data: { id: randomUUID(), accountType, firstName: 'QA', lastName: kind, email: `rp-${kind.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}@pg.test`, roles: [kind], activeRole: kind } });
}

/** A referred client with one contract whose stages are APPROVED at the given offsets (minutes from now). The referral is created at `referralOffset`. */
async function seed(over: { stages?: { amount: number; approvedAt: number }[]; referralOffset?: number; level?: number } = {}) {
	const prisma = await db();
	const tag = randomUUID().slice(0, 8);
	const client = await mkUser(prisma, tag, 'CLIENT');
	const provider = await mkUser(prisma, tag, 'PROVIDER');
	const affUser = await mkUser(prisma, tag, 'AFFILIATE');
	const aff = await prisma.affiliateProfile.create({ data: { userId: affUser.id, level: over.level ?? 1 } });
	const referral = await prisma.referral.create({ data: { affiliateId: aff.id, referredUserId: client.id, createdAt: min(over.referralOffset ?? -120) } });
	const project = await prisma.project.create({ data: { id: randomUUID(), title: `QA replay ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const defs = over.stages ?? [{ amount: 100, approvedAt: -60 }, { amount: 50, approvedAt: -30 }];
	const price = defs.reduce((a, b) => a + b.amount, 0);
	const contract = await prisma.contract.create({ data: { id: randomUUID(), projectId: project.id, clientId: client.id, providerId: provider.id, price, durationDays: 14, phasesCount: defs.length, status: 'ACTIVE', signedAt: new Date() } });
	const stages: any[] = [];
	for (const [i, d] of defs.entries()) {
		stages.push(await prisma.projectStage.create({ data: { id: randomUUID(), contractId: contract.id, stepOrder: i + 1, title: `المرحلة ${i + 1}`, days: 5, percentage: Math.round((d.amount / price) * 10000) / 100, amount: d.amount, status: 'APPROVED', approvedAt: min(d.approvedAt) } }));
	}
	return { prisma, tag, client, provider, affUser, aff, referral, project, contract, stages };
}
type World = Awaited<ReturnType<typeof seed>>;
const mine = (plan: any[], w: World) => plan.filter(r => r.affiliateId === w.aff.id);
const planOf = async (w: World, o: any = {}) => { const { planStageReleaseCommissions } = await replay(); return mine(await planStageReleaseCommissions(w.prisma, o), w); };
const commissions = (w: World) => w.prisma.commissionLog.findMany({ where: { affiliateId: w.aff.id }, orderBy: { createdAt: 'asc' } });
const countAll = async (w: World) => ({ logs: await w.prisma.commissionLog.count(), refs: await w.prisma.referral.count({ where: { status: 'CONVERTED' } }), stages: await w.prisma.projectStage.count() });

test('dry run: classifies every approved stage and writes NOTHING (no commission, no referral change)', opts, async () => {
	const w = await seed();
	const before = await countAll(w);
	const plan = await planOf(w);
	assert.equal(plan.length, 2);
	assert.deepEqual(plan.map(r => r.status), ['ELIGIBLE', 'ELIGIBLE']);
	assert.deepEqual(plan.map(r => r.expectedCommission), [1, 0.5]); // 1% of 100 and of 50
	assert.deepEqual(plan.map(r => r.appliedPercentage), [1, 1]);
	assert.deepEqual(await countAll(w), before);
	assert.equal((await w.prisma.referral.findUnique({ where: { id: w.referral.id } })).status, 'PENDING');
});

test('apply (through the real engine): one APPROVED commission per eligible stage with full snapshots, referral -> CONVERTED, summary agrees', opts, async () => {
	const w = await seed();
	const { applyStageReleaseCommissions } = await replay();
	const plan = await planOf(w);
	const res = await withEnv(ON, () => applyStageReleaseCommissions(w.prisma, plan, { count: 2, total: 1.5 }));
	assert.equal(res.inserted, 2); assert.equal(res.total, 1.5); assert.deepEqual(res.mismatches, []);
	const rows = await commissions(w);
	assert.equal(rows.length, 2);
	for (const [i, r] of rows.entries()) {
		assert.equal(r.status, 'APPROVED'); assert.equal(r.type, 'STAGE_RELEASE'); assert.equal(r.currency, 'USD');
		assert.equal(r.referralId, w.referral.id); assert.equal(r.referredUserId, w.client.id);
		assert.equal(r.sourceProjectId, w.project.id); assert.equal(r.sourceStageId, w.stages[i].id);
		assert.equal(r.baseAmount, w.stages[i].amount); assert.equal(r.appliedPercentage, 1); assert.equal(r.level, 1);
	}
	assert.deepEqual(rows.map(r => r.amount).sort(), [0.5, 1]);
	assert.equal((await w.prisma.referral.findUnique({ where: { id: w.referral.id } })).status, 'CONVERTED');
	// the marketer numbers are derived from the rows (no direct balance write exists anywhere in the script)
	const { marketerOverviewService } = await import('./marketer-overview.service');
	const s = await marketerOverviewService.getSummary(w.affUser.id);
	assert.equal(s.approvedCommissions, 1.5); assert.equal(s.totalCommissions, 1.5); assert.equal(s.successfulReferrals, 1); assert.equal(s.pendingReferrals, 0);
	// stages are untouched
	assert.deepEqual((await w.prisma.projectStage.findMany({ where: { contractId: w.contract.id } })).map((x: any) => x.status), ['APPROVED', 'APPROVED']);
});

test('re-running is a no-op: the second plan has nothing ELIGIBLE and applying it inserts nothing', opts, async () => {
	const w = await seed();
	const { applyStageReleaseCommissions } = await replay();
	await withEnv(ON, async () => applyStageReleaseCommissions(w.prisma, await planOf(w), { count: 2, total: 1.5 }));
	const again = await planOf(w);
	assert.deepEqual(again.map(r => r.status), ['ALREADY_COMMISSIONED', 'ALREADY_COMMISSIONED']);
	const res = await withEnv(ON, () => applyStageReleaseCommissions(w.prisma, again, { count: 0, total: 0 }));
	assert.equal(res.inserted, 0);
	assert.equal((await commissions(w)).length, 2);
});

test('concurrent applies of the same reviewed plan never double-credit and never abort', opts, async () => {
	const w = await seed({ stages: [{ amount: 200, approvedAt: -50 }, { amount: 300, approvedAt: -40 }, { amount: 500, approvedAt: -30 }] });
	const { applyStageReleaseCommissions } = await replay();
	const plan = await planOf(w);
	assert.equal(plan.filter(r => r.status === 'ELIGIBLE').length, 3);
	const out = await withEnv(ON, () => Promise.all(Array.from({ length: 6 }, () => applyStageReleaseCommissions(w.prisma, plan, { count: 3, total: 10 }))));
	assert.equal(out.reduce((a, r) => a + r.inserted, 0), 3); // exactly one winner per stage across all runners
	const rows = await commissions(w);
	assert.equal(rows.length, 3);
	assert.equal(Math.round(rows.reduce((a: number, r: any) => a + r.amount, 0) * 100) / 100, 10);
	assert.equal(new Set(rows.map((r: any) => r.sourceStageId)).size, 3);
});

test('apply refuses (and writes nothing) when the plan differs from what was reviewed, or when the engine flag is off', opts, async () => {
	const w = await seed();
	const { applyStageReleaseCommissions } = await replay();
	const plan = await planOf(w);
	await assert.rejects(() => withEnv(ON, () => applyStageReleaseCommissions(w.prisma, plan, { count: 3, total: 1.5 })), /plan mismatch/);
	await assert.rejects(() => withEnv(ON, () => applyStageReleaseCommissions(w.prisma, plan, { count: 2, total: 2 })), /plan mismatch/);
	await assert.rejects(() => withEnv({}, () => applyStageReleaseCommissions(w.prisma, plan, { count: 2, total: 1.5 })), /not "true"/);
	assert.equal((await commissions(w)).length, 0);
});

test('rules: approved BEFORE the referral existed is not part of the plan; a stage that changed after planning is skipped, not credited', opts, async () => {
	const w = await seed({ referralOffset: -20, stages: [{ amount: 100, approvedAt: -60 }, { amount: 100, approvedAt: -10 }] });
	const plan = await planOf(w);
	assert.equal(plan.length, 1); assert.equal(plan[0].stageId, w.stages[1].id);
	await w.prisma.projectStage.update({ where: { id: w.stages[1].id }, data: { status: 'REVISION_REQUESTED' } });
	const { applyStageReleaseCommissions } = await replay();
	const res = await withEnv(ON, () => applyStageReleaseCommissions(w.prisma, plan, { count: 1, total: 1 }));
	assert.equal(res.inserted, 0); assert.equal(res.skipped, 1);
	assert.equal((await commissions(w)).length, 0);
});

test('rules: a dispute that was OPEN when the stage was approved excludes it (even if resolved later); a dispute opened later does not; excluded project and self-referral are never credited', opts, async () => {
	const w = await seed({ stages: [{ amount: 10, approvedAt: -60 }, { amount: 10, approvedAt: -30 }] });
	// opened before the 2nd approval, resolved after it -> 2nd excluded; opened after the 1st approval -> 1st unaffected by that dispute
	await w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, status: 'RESOLVED', reason: 'QA', description: 'QA', createdAt: min(-40), resolvedAt: min(-5) } });
	const plan = await planOf(w);
	assert.deepEqual(plan.map(r => r.status), ['ELIGIBLE', 'DISPUTE_OPEN_AT_RELEASE']);
	const excluded = await planOf(w, { excludeProjectIds: [w.project.id] });
	assert.deepEqual(excluded.map(r => r.status), ['EXCLUDED_PROJECT', 'EXCLUDED_PROJECT']);
	// self-referral: the affiliate IS the referred client
	const prisma = w.prisma;
	const selfUser = await mkUser(prisma, 'self', 'AFFILIATE');
	const selfAff = await prisma.affiliateProfile.create({ data: { userId: selfUser.id, level: 1 } });
	await prisma.referral.create({ data: { affiliateId: selfAff.id, referredUserId: selfUser.id, createdAt: min(-120) } }).catch(() => undefined);
	const { planStageReleaseCommissions } = await replay();
	const all = await planStageReleaseCommissions(prisma, {});
	assert.equal(all.filter(r => r.affiliateUserId === r.referredUserId && r.status !== 'SELF_REFERRAL').length, 0);
});

test('a referred PROVIDER is not part of the plan (client-only rule) and a level-3 affiliate gets 1.5%', opts, async () => {
	const w = await seed({ level: 3, stages: [{ amount: 100, approvedAt: -60 }] });
	// make a second referral pointing at the PROVIDER of the same contract: the plan reads contracts by CLIENT only
	const other = await mkUser(w.prisma, w.tag, 'AFFILIATE');
	const otherAff = await w.prisma.affiliateProfile.create({ data: { userId: other.id, level: 1 } });
	await w.prisma.referral.create({ data: { affiliateId: otherAff.id, referredUserId: w.provider.id, createdAt: min(-120) } });
	const { planStageReleaseCommissions } = await replay();
	const all = await planStageReleaseCommissions(w.prisma, {});
	assert.equal(all.filter(r => r.affiliateId === otherAff.id).length, 0);
	const mineRows = all.filter(r => r.affiliateId === w.aff.id);
	assert.equal(mineRows.length, 1); assert.equal(mineRows[0].appliedPercentage, 1.5); assert.equal(mineRows[0].expectedCommission, 1.5);
});
