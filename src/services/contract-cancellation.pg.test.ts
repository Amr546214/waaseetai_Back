import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests for «الإلغاء بالتراضي» (isolated local database only, synthetic data only; see pg-concurrency.pg.test.ts).
 * The core claim: the request lifecycle works and NO money / contract / stage / escrow row is ever changed by it.
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

let _p: any; const db = async () => (_p ??= (await import('../config/db')).prisma);
let _s: any; const svc = async () => (_s ??= (await import('./contract-cancellation.service')).contractCancellationService);

async function world(over: { contractStatus?: string; released?: number } = {}) {
	const prisma = await db(); const id = () => randomUUID(); const tag = id().slice(0, 8);
	const mk = (accountType: string, role: string, n: string) => prisma.user.create({ data: { id: id(), accountType, firstName: 'QA', lastName: n, email: `qa-${n}-${tag}@pg.test`, roles: [role], activeRole: role, status: 'ACTIVE' } });
	const client = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'client'); const provider = await mk('PROVIDER_INDIVIDUAL', 'PROVIDER', 'prov'); const outsider = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'out');
	const project = await prisma.project.create({ data: { id: id(), title: `QA cancel ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: 2, status: over.contractStatus ?? 'ACTIVE', signedAt: new Date() } });
	const escrow = await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 20, releasedAmount: over.released ?? 0, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date(), paymentMethod: 'WALLET', paymentReference: `PG-${tag}`, fundedAt: new Date() } });
	await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'S1', days: 7, percentage: 50, amount: 10, status: over.released ? 'APPROVED' : 'IN_PROGRESS' } });
	await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 2, title: 'S2', days: 7, percentage: 50, amount: 10, status: 'PENDING' } });
	const V = { c: { userId: client.id, side: 'CLIENT' as const }, p: { userId: provider.id, side: 'PROVIDER' as const }, o: { userId: outsider.id, side: 'CLIENT' as const } };
	return { prisma, client, provider, outsider, project, contract, escrow, V };
}
/** every money-bearing row of the world, to prove it is byte-identical after any cancellation action */
const snapshot = async (w: Awaited<ReturnType<typeof world>>) => JSON.stringify({
	contract: await w.prisma.contract.findUnique({ where: { id: w.contract.id }, select: { status: true, price: true, durationDays: true, termsVersion: true } }),
	escrow: await w.prisma.escrow.findUnique({ where: { id: w.escrow.id }, select: { amount: true, releasedAmount: true, status: true, platformCommissionAmount: true, providerNetReleasedAmount: true } }),
	stages: await w.prisma.projectStage.findMany({ where: { contractId: w.contract.id }, orderBy: { stepOrder: 'asc' }, select: { amount: true, status: true, percentage: true } }),
	users: await w.prisma.user.findMany({ where: { id: { in: [w.client.id, w.provider.id] } }, orderBy: { id: 'asc' }, select: { walletBalance: true } }),
	wtx: await w.prisma.walletTransaction.count({ where: { userId: { in: [w.client.id, w.provider.id] } } })
});
const code = async (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.statusCode as number);

test('pg: create -> accept records the agreement and moves NO money (snapshot identical, settlement waits)', opts, async () => {
	const s = await svc(); const w = await world(); const before = await snapshot(w);
	const r: any = await s.create(w.V.c, w.contract.id, { reason: 'تغيّرت احتياجات المشروع', note: 'ملاحظة' });
	assert.equal(r.status, 'PENDING_OTHER_PARTY'); assert.equal(r.canWithdraw, true); assert.equal(r.canRespond, false); assert.equal(r.moneyMoved, false);
	const seenByProvider = (await s.listForContract(w.V.p, w.project.id)).requests[0]; assert.equal(seenByProvider.canRespond, true); assert.equal(seenByProvider.requestedByRole, 'CLIENT');
	const a: any = await s.respond(w.V.p, r.id, 'accept', 'موافق');
	assert.equal(a.status, 'ACCEPTED'); assert.equal(a.settlementStatus, 'PENDING_ADMIN_DECISION'); assert.equal(a.moneyMoved, false);
	assert.equal(await snapshot(w), before, 'contract, escrow, stages, wallets and wallet transactions untouched');
	assert.equal((await s.getForAdmin(r.id)).financial.escrowHeld, 20);
});

test('pg: already-released milestones are untouched and shown as facts only', opts, async () => {
	const s = await svc(); const w = await world({ released: 10 }); const before = await snapshot(w);
	const r: any = await s.create(w.V.p, w.project.id, { reason: 'اتفاق ودّي' });
	await s.respond(w.V.c, r.id, 'accept');
	assert.equal(await snapshot(w), before);
	const f = (await s.listForContract(w.V.c, w.contract.id)).financial; assert.deepEqual([f.escrowReleased, f.escrowHeld], [10, 10]);
});

test('pg: reject and withdraw end the request, move nothing, and a new request is possible afterwards', opts, async () => {
	const s = await svc(); const w = await world(); const before = await snapshot(w);
	const r1: any = await s.create(w.V.c, w.contract.id, { reason: 'السبب الأول' });
	assert.equal((await s.respond(w.V.p, r1.id, 'reject')).status, 'REJECTED');
	const r2: any = await s.create(w.V.p, w.contract.id, { reason: 'السبب الثاني' });
	assert.equal((await s.withdraw(w.V.p, r2.id)).status, 'WITHDRAWN');
	const r3: any = await s.create(w.V.c, w.contract.id, { reason: 'السبب الثالث' });
	assert.equal(r3.status, 'PENDING_OTHER_PARTY');
	assert.equal(await snapshot(w), before);
});

test('pg: authorisation matrix - outsider, requester answering own request, non-requester withdrawing, wrong side', opts, async () => {
	const s = await svc(); const w = await world();
	assert.equal(await code(s.create(w.V.o, w.contract.id, { reason: 'x'.repeat(5) })), 404, 'outsider cannot create');
	assert.equal(await code(s.listForContract(w.V.o, w.contract.id)), 404, 'outsider cannot list');
	const r: any = await s.create(w.V.c, w.contract.id, { reason: 'سبب الإلغاء' });
	assert.equal(await code(s.respond(w.V.c, r.id, 'accept')), 403, 'requester cannot answer own request');
	assert.equal(await code(s.respond(w.V.o, r.id, 'accept')), 404, 'outsider cannot answer');
	assert.equal(await code(s.withdraw(w.V.p, r.id)), 403, 'only the requester withdraws');
	assert.equal(await code(s.withdraw(w.V.o, r.id)), 404);
	assert.equal(await code(s.respond(w.V.p, r.id, 'maybe')), 400);
	// a PROVIDER-side viewer id used on the CLIENT side finds no contract (side comes from the router, ids are never trusted across roles)
	assert.equal(await code(s.listForContract({ userId: w.provider.id, side: 'CLIENT' }, w.contract.id)), 404);
});

test('pg: duplicate submit - same requestKey returns the same row; 10 parallel creates give exactly ONE request', opts, async () => {
	const s = await svc(); const w = await world();
	const a: any = await s.create(w.V.c, w.contract.id, { reason: 'سبب واحد', requestKey: 'k1' }); const b: any = await s.create(w.V.c, w.contract.id, { reason: 'سبب واحد', requestKey: 'k1' });
	assert.equal(a.id, b.id); assert.equal(b.replayed, true);
	const w2 = await world();
	const res = await Promise.all(Array.from({ length: 10 }, (_, i) => code(s.create(w2.V.c, w2.contract.id, { reason: `سبب ${i}`, requestKey: `p${i}` }))));
	assert.equal(res.filter(x => x === 200).length, 1, JSON.stringify(res)); assert.ok(res.every(x => x === 200 || x === 409), JSON.stringify(res));
	assert.equal(await w2.prisma.contractCancellationRequest.count({ where: { contractId: w2.contract.id } }), 1);
});

test('pg: double accept / accept-vs-reject race / accept after withdraw', opts, async () => {
	const s = await svc(); const w = await world();
	const r: any = await s.create(w.V.c, w.contract.id, { reason: 'سبب الإلغاء' });
	const [x, y] = await Promise.all([code(s.respond(w.V.p, r.id, 'accept')), code(s.respond(w.V.p, r.id, 'reject'))]);
	assert.deepEqual([x, y].sort(), [200, 409]);
	const final = (await w.prisma.contractCancellationRequest.findUnique({ where: { id: r.id } })).status;
	assert.equal((await s.respond(w.V.p, r.id, final === 'ACCEPTED' ? 'accept' : 'reject')).replayed, true, 'same answer again is a harmless replay');
	assert.equal(await code(s.respond(w.V.p, r.id, final === 'ACCEPTED' ? 'reject' : 'accept')), 409, 'the opposite answer is refused');
	const w2 = await world(); const r2: any = await s.create(w2.V.c, w2.contract.id, { reason: 'سبب الإلغاء' });
	await s.withdraw(w2.V.c, r2.id); assert.equal(await code(s.respond(w2.V.p, r2.id, 'accept')), 409);
});

test('pg: accepted request blocks a second one; contract must be ACTIVE; open dispute blocks', opts, async () => {
	const s = await svc(); const w = await world();
	const r: any = await s.create(w.V.c, w.contract.id, { reason: 'سبب الإلغاء' }); await s.respond(w.V.p, r.id, 'accept');
	assert.equal(await code(s.create(w.V.p, w.contract.id, { reason: 'سبب آخر' })), 409);
	for (const st of ['PENDING_PAYMENT', 'COMPLETED', 'CANCELLED', 'DISPUTED']) { const x = await world({ contractStatus: st }); assert.equal(await code(s.create(x.V.c, x.contract.id, { reason: 'سبب الإلغاء' })), 409, st); }
	const d = await world(); await d.prisma.dispute.create({ data: { id: randomUUID(), projectId: d.project.id, openedById: d.client.id, againstUserId: d.provider.id, reason: 'x', description: 'y'.repeat(30), status: 'OPEN' } });
	assert.equal(await code(s.create(d.V.p, d.contract.id, { reason: 'سبب الإلغاء' })), 409);
	// a dispute that opens AFTER the request was made blocks the accept
	const e = await world(); const er: any = await s.create(e.V.c, e.contract.id, { reason: 'سبب الإلغاء' });
	await e.prisma.dispute.create({ data: { id: randomUUID(), projectId: e.project.id, openedById: e.client.id, againstUserId: e.provider.id, reason: 'x', description: 'y'.repeat(30), status: 'UNDER_REVIEW' } });
	assert.equal(await code(s.respond(e.V.p, er.id, 'accept')), 409);
});

test('pg: validation - reason required/limits, DB CHECK refuses a requester who is not a party', opts, async () => {
	const s = await svc(); const w = await world();
	assert.equal(await code(s.create(w.V.c, w.contract.id, { reason: '  ' })), 400); assert.equal(await code(s.create(w.V.c, w.contract.id, { reason: 'x'.repeat(201) })), 400); assert.equal(await code(s.create(w.V.c, w.contract.id, { reason: 'سبب', note: 'n'.repeat(2001) })), 400);
	await assert.rejects(w.prisma.contractCancellationRequest.create({ data: { contractId: w.contract.id, projectId: w.project.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.outsider.id, requestedByRole: 'CLIENT', reason: 'direct insert' } }));
});
