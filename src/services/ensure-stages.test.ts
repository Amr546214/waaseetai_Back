import { test } from 'node:test';
import assert from 'node:assert/strict';

// ensureStages: created once even under concurrent callers, never touches existing stages, and the rows always add up to the contract.
type Row = { contractId: string; stepOrder: number; title: string; amount: number; percentage: number; status: string };

function fakeDb(opts: { price: number; terms?: unknown; proposalMilestones?: any[]; existing?: Row[] }) {
	const rows: Row[] = [...(opts.existing ?? [])];
	const calls = { createMany: 0, findMany: 0 };
	const db = {
		projectStage: {
			findMany: async () => { calls.findMany++; await new Promise(r => setImmediate(r)); return rows.map(r => ({ ...r })); },
			createMany: async ({ data }: any) => {
				calls.createMany++;
				// atomic multi-row insert + the unique (contractId, stepOrder) index
				if (data.some((d: any) => rows.some(r => r.contractId === d.contractId && r.stepOrder === d.stepOrder))) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
				for (const d of data) rows.push({ contractId: d.contractId, stepOrder: d.stepOrder, title: d.title, amount: d.amount, percentage: d.percentage, status: d.status });
				return { count: data.length };
			}
		},
		contract: { findUnique: async () => ({ id: 'c1', status: 'ACTIVE', price: opts.price, durationDays: 6, offerId: 'o1', projectId: 'p1', providerId: 'pr1', signedAt: new Date(), terms: opts.terms ?? null, project: { description: 'وصف' } }) },
		projectProposal: { findUnique: async () => ({ milestones: opts.proposalMilestones ?? [] }), findFirst: async () => null }
	};
	return { db, rows, calls };
}
async function load(t: any, db: any) {
	t.mock.module('../config/db', { namedExports: { prisma: db } });
	return await import(`./project-progress.service?${Math.random()}`);
}
const two = [{ stepOrder: 1, title: 'تحليل', description: 'a', days: 3, percentage: 50, amount: 25 }, { stepOrder: 2, title: 'تنفيذ', description: 'b', days: 3, percentage: 50, amount: 25 }];

test('concurrent callers create the stages exactly once (no duplicates, no error)', async t => {
	const { db, rows, calls } = fakeDb({ price: 50, proposalMilestones: two });
	const { projectProgressService } = await load(t, db);
	await Promise.all([projectProgressService.ensureStages('c1'), projectProgressService.ensureStages('c1'), projectProgressService.ensureStages('c1')]);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map(r => [r.stepOrder, r.status]), [[1, 'IN_PROGRESS'], [2, 'PENDING']]);
	assert.ok(calls.createMany >= 1);
});

test('a later call never touches stages that already exist (even a different set)', async t => {
	const existing: Row[] = [{ contractId: 'c1', stepOrder: 1, title: 'قديمة', amount: 50, percentage: 100, status: 'APPROVED' }];
	const { db, rows, calls } = fakeDb({ price: 50, proposalMilestones: two, existing });
	const { projectProgressService } = await load(t, db);
	await projectProgressService.ensureStages('c1');
	assert.equal(calls.createMany, 0);
	assert.deepEqual(rows, existing);
});

test('the frozen contract terms are preferred and a valid split is used as is', async t => {
	const frozen = { price: 50, version: 1, milestones: [{ stepOrder: 1, title: 'م1', description: 'x', days: 2, percentage: 40, amount: 20 }, { stepOrder: 2, title: 'م2', description: 'y', days: 4, percentage: 60, amount: 30 }] };
	const { db, rows } = fakeDb({ price: 50, terms: frozen, proposalMilestones: two });
	const { projectProgressService } = await load(t, db);
	await projectProgressService.ensureStages('c1');
	assert.deepEqual(rows.map(r => [r.title, r.amount]), [['م1', 20], ['م2', 30]]);
	assert.equal(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, 50);
});

test('stages that do not add up to the contract are never created: one stage for the whole price instead', async t => {
	const bad = [{ stepOrder: 1, title: 'a', description: 'a', days: 3, percentage: 50, amount: 20 }, { stepOrder: 2, title: 'b', description: 'b', days: 3, percentage: 50, amount: 25 }]; // 45 != 50
	const { db, rows } = fakeDb({ price: 50, proposalMilestones: bad });
	const { projectProgressService } = await load(t, db);
	await projectProgressService.ensureStages('c1');
	assert.equal(rows.length, 1);
	assert.equal(rows[0].amount, 50);
	assert.equal(rows[0].percentage, 100);
});

test('percentages that do not reach 100 are rejected too', async t => {
	const bad = [{ stepOrder: 1, title: 'a', description: 'a', days: 3, percentage: 50, amount: 25 }, { stepOrder: 2, title: 'b', description: 'b', days: 3, percentage: 40, amount: 25 }];
	const { db, rows } = fakeDb({ price: 50, proposalMilestones: bad });
	const { projectProgressService } = await load(t, db);
	await projectProgressService.ensureStages('c1');
	assert.deepEqual(rows.map(r => r.amount), [50]);
});

test('stagesMatchContract: tolerance 0.01, unique orders, finite numbers', async t => {
	const { db } = fakeDb({ price: 1 });
	const { stagesMatchContract } = await load(t, db);
	assert.equal(stagesMatchContract([{ stepOrder: 1, amount: 8.72, percentage: 43.6 }, { stepOrder: 2, amount: 8.73, percentage: 56.4 }], 17.45), true);
	assert.equal(stagesMatchContract([{ stepOrder: 1, amount: 10, percentage: 50 }, { stepOrder: 1, amount: 10, percentage: 50 }], 20), false);
	assert.equal(stagesMatchContract([{ stepOrder: 1, amount: 'x', percentage: 100 }], 20), false);
	assert.equal(stagesMatchContract([], 20), false);
	assert.equal(stagesMatchContract([{ stepOrder: 1, amount: 20.02, percentage: 100 }], 20), false);
});
