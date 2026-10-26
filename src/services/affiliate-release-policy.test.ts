import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Which table does a marketer's commission read at RELEASE time? The ladder of the policy version stored on the ESCROW (the one in force when it was funded) - never the newest effective policy.
 * The marketer's own LEVEL is still read at each release (existing behaviour, left unchanged; the owner has not decided it): this file also pins that and prices the difference with a worked example.
 */
process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED = 'true';
const ladder = (base: number) => Array.from({ length: 15 }, (_, i) => Math.round((base + i * 0.1) * 100) / 100);
const P_FUNDED = { id: 'p-funded', version: 3, payload: { marketerCommissionByLevel: ladder(1.0) } };   // in force when the escrow was funded
const P_NEWEST = { id: 'p-newest', version: 4, payload: { marketerCommissionByLevel: ladder(2.0) } };   // scheduled later, in force now
mock.module('./fee-policy.service', { namedExports: { feePolicyService: { byId: async (id: string | null) => (id === 'p-funded' ? P_FUNDED : P_NEWEST), active: async () => P_NEWEST } } });
mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });

const fakeTx = (level: number, escrow: { feePolicyId: string | null; createdAt: Date; currency?: string }, written: any[]) => ({
	dispute: { findFirst: async () => null },
	escrow: { findFirst: async () => escrow },
	referral: { findMany: async () => [{ id: 'r1', referredUserId: 'client', affiliate: { id: 'a1', level, userId: 'm1' } }], updateMany: async () => ({ count: 1 }) },
	commissionLog: { createMany: async ({ data }: any) => { written.push(...data); return { count: data.length }; } },
}) as any;
const contract = { id: 'c1', projectId: 'p1', clientId: 'client', providerId: 'prov' };

test('release time: the commission uses the ladder stored on the ESCROW (policy in force at funding), not the newest effective policy', async () => {
	const { createCommissionsForStageReleaseEvent } = await import('./affiliate-commission.service');
	const written: any[] = [];
	await createCommissionsForStageReleaseEvent(fakeTx(3, { feePolicyId: 'p-funded', createdAt: new Date('2026-10-20') }, written), { contract, stageId: 's1', releasedAmount: 1000 });
	assert.equal(written[0].appliedPercentage, P_FUNDED.payload.marketerCommissionByLevel[2], 'level 3 on the FUNDED policy ladder');
	assert.notEqual(written[0].appliedPercentage, P_NEWEST.payload.marketerCommissionByLevel[2], 'never the newest ladder');
	assert.equal(written[0].amount, 12, '1000 x 1.2%');
});

test('the commission row and its notice carry the escrow\'s currency', async () => {
	const { createCommissionsForStageReleaseEvent } = await import('./affiliate-commission.service');
	const written: any[] = [];
	const notices = await createCommissionsForStageReleaseEvent(fakeTx(1, { feePolicyId: 'p-funded', createdAt: new Date('2026-10-20'), currency: 'SAR' }, written), { contract, stageId: 's2', releasedAmount: 100 });
	assert.equal(written[0].currency, 'SAR'); assert.equal(notices[0].currency, 'SAR');
});

test('WORKED EXAMPLE (owner decision pending): freezing the marketer level at funding vs reading it at every release', async () => {
	const { calculateAffiliateCommission } = await import('./affiliate-commission.service');
	const table = P_FUNDED.payload.marketerCommissionByLevel;
	const stages = [{ id: 's1', amount: 400, levelAtRelease: 3 }, { id: 's2', amount: 300, levelAtRelease: 9 }, { id: 's3', amount: 300, levelAtRelease: 9 }]; // the marketer levels up between stage 1 and 2
	const fundedLevel = 3;
	const live = stages.reduce((s, st) => s + calculateAffiliateCommission(st.levelAtRelease, st.amount, table).amount, 0);        // today's behaviour
	const frozen = stages.reduce((s, st) => s + calculateAffiliateCommission(fundedLevel, st.amount, table).amount, 0);             // the alternative
	assert.ok(live > frozen, 'a level-up between funding and release costs the platform more under today\'s rule');
	assert.deepEqual({ live: Math.round(live * 100) / 100, frozen: Math.round(frozen * 100) / 100 }, { live: 15.6, frozen: 12 }, '1000 contract on the funded ladder: 4.80 + 5.40 + 5.40 = 15.60 (level read at each release) vs 12.00 (level 3 frozen at funding): +3.60 for the platform');
});
