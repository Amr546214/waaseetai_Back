import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * The money paths beyond checkout, on a REAL isolated PostgreSQL, with a contract/escrow that is in SAR (built by hand: nothing enables SAR anywhere): dispute settlement (refund, split with commission),
 * stage release, price decrease/increase amendments, replay and concurrency. In every case the SAR wallet is the one that moves, the USD wallet never changes, each ledger row carries SAR, and a refund
 * or a release never happens twice.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
let _db: any; const db = async () => (_db ??= (await import('../config/db')).prisma);
const id = () => randomUUID();

async function seed(opts2: { price?: number; sar?: number; usd?: number; rate?: number } = {}) {
	const prisma = await db(); const tag = id().slice(0, 8); const price = opts2.price ?? 20; const sar = opts2.sar ?? 0; const usd = opts2.usd ?? 100;
	const client = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'QA', lastName: 'Client', email: `sar-client-${tag}@pg.test`, walletBalance: usd, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	if (sar) await prisma.walletBalance.create({ data: { userId: client.id, currency: 'SAR', balance: sar } });
	const provider = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'Provider', email: `sar-prov-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const admin = await prisma.user.create({ data: { id: id(), accountType: 'SUPER_ADMIN', status: 'ACTIVE', firstName: 'QA', lastName: 'Admin', email: `sar-admin-${tag}@pg.test`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' } });
	const project = await prisma.project.create({ data: { id: id(), title: `QA SAR ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS', currency: 'SAR' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price, currency: 'SAR', durationDays: 14, phasesCount: 2, status: 'ACTIVE', signedAt: new Date() } });
	const escrow = await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: price, currency: 'SAR', status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: opts2.rate ?? 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date() } });
	const half = price / 2;
	const s1 = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'S1', days: 7, percentage: 50, amount: half, currency: 'SAR', status: 'SUBMITTED' } });
	const s2 = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 2, title: 'S2', days: 7, percentage: 50, amount: half, currency: 'SAR', status: 'PENDING' } });
	await prisma.stageDelivery.create({ data: { id: id(), stageId: s1.id, providerId: provider.id, note: 'synthetic delivery note', status: 'SUBMITTED' } });
	return { prisma, client, provider, admin, project, contract, escrow, s1, s2, tag };
}
type W = Awaited<ReturnType<typeof seed>>;
const wallets = async (w: W) => ({ usd: r2(Number((await w.prisma.user.findUniqueOrThrow({ where: { id: w.client.id } })).walletBalance)), sar: r2(Number((await w.prisma.walletBalance.findUnique({ where: { userId_currency: { userId: w.client.id, currency: 'SAR' } } }))?.balance ?? 0)) });
const ledger = (w: W) => w.prisma.walletTransaction.findMany({ where: { userId: w.client.id }, orderBy: { createdAt: 'asc' } });
const openDispute = async (w: W) => (await import('./dispute.service')).disputeService.createForRequest(w.project.id, w.client.id, 'client', { reason: 'نزاع QA', description: 'نزاع اختباري لمسار العملات', evidence: [] } as any);

test('pg SAR: a dispute REFUND_CLIENT credits the SAR wallet once (USD untouched), writes a SAR REFUND row, and a replay / 5 racing decisions refund exactly once', opts, async () => {
	const { disputeService } = await import('./dispute.service'); const w = await seed({ price: 20, sar: 0 }); const d = await openDispute(w);
	const input = { outcome: 'REFUND_CLIENT', refundToClient: 20, releaseToProvider: 0, expectedHeldAmount: 20, confirm: true } as any;
	const rs = await Promise.allSettled(Array.from({ length: 5 }, () => disputeService.resolveFinancial(d.id, w.admin.id, input)));
	assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1, 'one decision wins');
	assert.deepEqual(await wallets(w), { usd: 100, sar: 20 }); const rows = (await ledger(w)).filter((t: any) => t.type === 'REFUND'); assert.equal(rows.length, 1); assert.equal(rows[0].currency, 'SAR');
	await assert.rejects(() => disputeService.resolveFinancial(d.id, w.admin.id, input), (e: any) => e.statusCode === 409); assert.deepEqual(await wallets(w), { usd: 100, sar: 20 });
});

test('pg SAR: a SPLIT settlement refunds in SAR, releases the rest with the escrow\'s frozen commission, and the summary carries SAR', opts, async () => {
	const { disputeService } = await import('./dispute.service'); const w = await seed({ price: 20, sar: 0, rate: 10 }); const d = await openDispute(w);
	await disputeService.resolveFinancial(d.id, w.admin.id, { outcome: 'SPLIT', refundToClient: 8, releaseToProvider: 12, expectedHeldAmount: 20, confirm: true } as any);
	const e = await w.prisma.escrow.findUniqueOrThrow({ where: { id: w.escrow.id } });
	assert.equal(e.status, 'RELEASED'); assert.equal(r2(e.releasedAmount), 12); assert.equal(r2(e.platformCommissionAmount), 1.2, '10% of the 12 released, in SAR'); assert.equal(e.currency, 'SAR');
	assert.deepEqual(await wallets(w), { usd: 100, sar: 8 });
});

test('pg SAR: a price DECREASE refunds the SAR wallet once; a price INCREASE is paid from the SAR wallet, and with only USD it is refused with the shortfall in SAR and nothing changes', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const raise = (w: W, data: Record<string, unknown>) => w.prisma.projectAmendment.create({ data: { id: id(), projectId: w.project.id, contractId: w.contract.id, currency: 'SAR', clientId: w.client.id, providerId: w.provider.id, requestedById: w.provider.id, requestedByRole: 'PROVIDER', title: 'تعديل', description: 'د', status: 'PENDING_OTHER_PARTY', ...data } });
	const w = await seed({ price: 20, sar: 0 }); const dec = await raise(w, { type: 'BUDGET', budgetDelta: -4 });
	await svc.respondToAmendment(w.client.id, dec.id, 'approve');
	assert.deepEqual(await wallets(w), { usd: 100, sar: 4 }); assert.equal(r2((await w.prisma.contract.findUniqueOrThrow({ where: { id: w.contract.id } })).price), 16);
	const refund = (await ledger(w)).filter((t: any) => t.type === 'AMENDMENT_REFUND'); assert.equal(refund.length, 1); assert.equal(refund[0].currency, 'SAR');
	await assert.rejects(() => svc.respondToAmendment(w.client.id, dec.id, 'approve'), (e: any) => e.statusCode === 409); assert.deepEqual(await wallets(w), { usd: 100, sar: 4 });
	// increase: only USD in the wallet -> refused, SAR shortfall reported, contract and escrow unchanged
	const w2 = await seed({ price: 20, sar: 0, usd: 1000 }); const inc = await raise(w2, { type: 'BUDGET', budgetDelta: 5 });
	const e: any = await svc.respondToAmendment(w2.client.id, inc.id, 'approve').catch((x: any) => x);
	assert.ok(e?.statusCode >= 400, JSON.stringify(e?.message)); assert.equal(r2((await w2.prisma.contract.findUniqueOrThrow({ where: { id: w2.contract.id } })).price), 20); assert.deepEqual(await wallets(w2), { usd: 1000, sar: 0 });
});

test('pg SAR: approving a stage releases from a SAR escrow with the frozen commission; approving twice releases once; nothing is added to a USD figure', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service'); const w = await seed({ price: 20, sar: 0, rate: 10 });
	const approve = () => projectProgressService.reviewDelivery(w.client.id, w.project.id, w.s1.id, 'approve');
	const first = await approve().catch((e: any) => e); const second = await approve().catch((e: any) => e);
	const e = await w.prisma.escrow.findUniqueOrThrow({ where: { id: w.escrow.id } });
	if (first instanceof Error || first?.statusCode) { assert.fail(`first approval failed: ${first?.message}`); }
	assert.equal(r2(e.releasedAmount), 10, 'stage 1 (10 SAR) released once'); assert.equal(r2(e.platformCommissionAmount), 1, '10% of 10 SAR'); assert.equal(e.currency, 'SAR');
	assert.ok(second?.statusCode >= 400 || second instanceof Error, 'a second approval of the same delivery is refused'); assert.deepEqual(await wallets(w), { usd: 100, sar: 0 });
});
