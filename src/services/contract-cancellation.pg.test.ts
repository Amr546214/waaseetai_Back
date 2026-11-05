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

async function world(over: { contractStatus?: string; released?: number; submitted?: boolean } = {}) {
	const prisma = await db(); const id = () => randomUUID(); const tag = id().slice(0, 8);
	const mk = (accountType: string, role: string, n: string) => prisma.user.create({ data: { id: id(), accountType, firstName: 'QA', lastName: n, email: `qa-${n}-${tag}@pg.test`, roles: [role], activeRole: role, status: 'ACTIVE' } });
	const client = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'client'); const provider = await mk('PROVIDER_INDIVIDUAL', 'PROVIDER', 'prov'); const outsider = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'out');
	const project = await prisma.project.create({ data: { id: id(), title: `QA cancel ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: 2, status: over.contractStatus ?? 'ACTIVE', signedAt: new Date() } });
	const escrow = await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 20, releasedAmount: over.released ?? 0, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date(), paymentMethod: 'WALLET', paymentReference: `PG-${tag}`, fundedAt: new Date() } });
	const s1 = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'S1', days: 7, percentage: 50, amount: 10, status: over.released ? 'APPROVED' : over.submitted ? 'SUBMITTED' : 'IN_PROGRESS' } });
	if (over.submitted) await prisma.stageDelivery.create({ data: { id: id(), stageId: s1.id, providerId: provider.id, note: 'synthetic delivery note', status: 'SUBMITTED' } });
	await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 2, title: 'S2', days: 7, percentage: 50, amount: 10, status: 'PENDING' } });
	const sa = await prisma.user.create({ data: { id: id(), accountType: 'SUPER_ADMIN', firstName: 'QA', lastName: 'sa', email: `qa-sa-${tag}@pg.test`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE' } });
	const V = { c: { userId: client.id, side: 'CLIENT' as const }, p: { userId: provider.id, side: 'PROVIDER' as const }, o: { userId: outsider.id, side: 'CLIENT' as const } };
	return { prisma, client, provider, outsider, project, contract, escrow, V, sa, s1 };
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

test('pg: create -> agree records the agreement and moves NO money (snapshot identical, settlement waits)', opts, async () => {
	const s = await svc(); const w = await world(); const before = await snapshot(w);
	const r: any = await s.create(w.V.c, w.contract.id, { reason: 'تغيّرت احتياجات المشروع', note: 'ملاحظة' });
	assert.equal(r.status, 'PENDING_OTHER_PARTY'); assert.equal(r.canWithdraw, true); assert.equal(r.canRespond, false); assert.equal(r.moneyMoved, false);
	const seenByProvider = (await s.listForContract(w.V.p, w.project.id)).requests[0]; assert.equal(seenByProvider.canRespond, true); assert.equal(seenByProvider.requestedByRole, 'CLIENT');
	const a: any = await s.respond(w.V.p, r.id, 'accept', 'موافق');
	assert.equal(a.status, 'AGREED_PENDING_SETTLEMENT'); assert.equal(a.settlementStatus, 'PENDING_ADMIN_DECISION'); assert.equal(a.moneyMoved, false); assert.equal(a.frozen, true);
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
	assert.equal((await s.respond(w.V.p, r.id, final === 'AGREED_PENDING_SETTLEMENT' ? 'accept' : 'reject')).replayed, true, 'same answer again is a harmless replay');
	assert.equal(await code(s.respond(w.V.p, r.id, final === 'AGREED_PENDING_SETTLEMENT' ? 'reject' : 'accept')), 409, 'the opposite answer is refused');
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
	assert.equal(await code(s.respond(e.V.p, er.id, 'accept')), 423);
});

test('pg: validation - reason required/limits, DB CHECK refuses a requester who is not a party', opts, async () => {
	const s = await svc(); const w = await world();
	assert.equal(await code(s.create(w.V.c, w.contract.id, { reason: '  ' })), 400); assert.equal(await code(s.create(w.V.c, w.contract.id, { reason: 'x'.repeat(201) })), 400); assert.equal(await code(s.create(w.V.c, w.contract.id, { reason: 'سبب', note: 'n'.repeat(2001) })), 400);
	await assert.rejects(w.prisma.contractCancellationRequest.create({ data: { contractId: w.contract.id, projectId: w.project.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.outsider.id, requestedByRole: 'CLIENT', reason: 'direct insert' } }));
});


// ───────────────────────── approved policy: freeze + admin settlement ─────────────────────────
import { projectProgressService } from './project-progress.service';
const staff = async (w: Awaited<ReturnType<typeof world>>, permissions: string[], type = 'ADMIN') => {
	const id = randomUUID(); const tag = id.slice(0, 8);
	const u = await w.prisma.user.create({ data: { id, accountType: type, firstName: 'QA', lastName: 'staff', email: `qa-staff-${tag}@pg.test`, roles: [type], activeRole: type, status: 'ACTIVE' } });
	const role = await w.prisma.adminRole.create({ data: { name: `qa ${tag}`, nameKey: `qa-${tag}`, permissions, createdById: w.sa.id } });
	await w.prisma.adminStaff.create({ data: { userId: id, roleId: role.id } });
	return u;
};
const FIN = ['disputes.view', 'disputes.resolve', 'payouts.send'];
const agree = async (w: Awaited<ReturnType<typeof world>>) => { const s = await svc(); const r: any = await s.create(w.V.c, w.contract.id, { reason: 'اتفاق على الإلغاء' }); await s.respond(w.V.p, r.id, 'accept'); return r.id as string; };
const money = async (w: Awaited<ReturnType<typeof world>>) => ({
	escrow: await w.prisma.escrow.findUnique({ where: { id: w.escrow.id } }), contract: await w.prisma.contract.findUnique({ where: { id: w.contract.id } }), project: await w.prisma.project.findUnique({ where: { id: w.project.id } }),
	client: Number((await w.prisma.user.findUnique({ where: { id: w.client.id } })).walletBalance), wtx: await w.prisma.walletTransaction.findMany({ where: { userId: w.client.id } })
});
const r2 = (n: number) => Math.round(n * 100) / 100;

test('pg: BEFORE agreement a stage approval pays the stage exactly as today; AFTER agreement a new approval is refused with 423 and moves nothing', opts, async () => {
	const w1 = await world({ submitted: true }); await projectProgressService.reviewDelivery(w1.client.id, w1.contract.id, w1.s1.id, 'approve');
	const e1 = await w1.prisma.escrow.findUnique({ where: { id: w1.escrow.id } }); assert.equal(e1.releasedAmount, 10, 'before agreement: the stage is paid');
	const w2 = await world({ submitted: true }); await agree(w2); const before = JSON.stringify(await money(w2));
	await assert.rejects(() => projectProgressService.reviewDelivery(w2.client.id, w2.contract.id, w2.s1.id, 'approve'), (e: any) => e.statusCode === 423 && e.code === 'CONTRACT_CANCELLATION_AGREED');
	assert.equal(JSON.stringify(await money(w2)), before); assert.equal((await w2.prisma.projectStage.findUnique({ where: { id: w2.s1.id } })).status, 'SUBMITTED');
});

test('pg: settlement permission matrix - viewer, resolve-only, payouts-only, outsider, client/provider all refused (403) and nothing moves; SUPER_ADMIN and the financial pair succeed', opts, async () => {
	const s = await svc(); const w = await world(); const id = await agree(w); const before = JSON.stringify(await money(w));
	const call = (uid: string) => code(s.settle(uid, id, { releaseToProvider: 5, expectedHeldAmount: 20, reason: 'قرار الإدارة للتسوية' }));
	for (const perms of [['disputes.view'], ['disputes.view', 'disputes.resolve'], ['disputes.view', 'payouts.send'], []]) assert.equal(await call((await staff(w, perms)).id), 403, JSON.stringify(perms));
	assert.equal(await call(w.client.id), 403); assert.equal(await call(w.provider.id), 403); assert.equal(await call(w.outsider.id), 403);
	assert.equal(JSON.stringify(await money(w)), before);
	const ok: any = await s.settle((await staff(w, FIN)).id, id, { releaseToProvider: 5, expectedHeldAmount: 20, reason: 'قرار الإدارة للتسوية' }); assert.equal(ok.status, 'SETTLED');
	const w2 = await world(); const id2 = await agree(w2); assert.equal((await s.settle(w2.sa.id, id2, { releaseToProvider: 0, expectedHeldAmount: 20, reason: 'استرداد كامل للعميل' }) as any).status, 'SETTLED');
	const adminView: any = await s.getForAdmin(id, (await staff(w, ['disputes.view'])).id); assert.equal(adminView.settlementPreview.viewerHoldsFinancialPermission, false);
});

test('pg: settled amounts equal the REAL remainder exactly (refund + provider share = held), commission as resolve-financial, released-before money untouched, contract+project closed together', opts, async () => {
	const s = await svc();
	for (const [released, share] of [[10, 4.99], [10, 10], [0, 7.77], [10, 0]] as const) {
		const w = await world({ released }); const id = await agree(w); const held = r2(20 - released);
		const wb = await w.prisma.escrow.findUnique({ where: { id: w.escrow.id } }); const stagesBefore = JSON.stringify(await w.prisma.projectStage.findMany({ where: { contractId: w.contract.id }, orderBy: { stepOrder: 'asc' } }));
		const out: any = await s.settle(w.sa.id, id, { releaseToProvider: share, expectedHeldAmount: held, reason: 'تسوية بقرار الإدارة' });
		assert.equal(r2(out.settlement.refundToClient + out.settlement.releaseToProvider), held, 'refund + provider share = remainder'); assert.equal(out.settlement.refundToClient, r2(held - share));
		const m = await money(w); assert.equal(m.client, out.settlement.refundToClient); assert.equal(m.contract.status, 'CANCELLED'); assert.equal(m.project.status, share > 0 ? 'COMPLETED' : 'DISPUTED');
		assert.equal(m.escrow.status, share > 0 ? 'RELEASED' : 'REFUNDED'); assert.equal(r2(m.escrow.releasedAmount), r2(released + share));
		if (share > 0) { const c = r2(Math.round((released + share) * 12.75) / 100); assert.equal(r2(m.escrow.platformCommissionAmount), c, 'cumulative commission rule'); assert.equal(out.settlement.platformCommission, r2(c - wb.platformCommissionAmount)); assert.equal(out.settlement.providerNet, r2(share - out.settlement.platformCommission)); }
		assert.equal(JSON.stringify(await w.prisma.projectStage.findMany({ where: { contractId: w.contract.id }, orderBy: { stepOrder: 'asc' } })), stagesBefore, 'stage rows untouched (paid ones stay paid)');
		assert.equal(m.wtx.length, out.settlement.refundToClient > 0 ? 1 : 0);
	}
});

test('pg: validation - share above the remainder, stale expectedHeldAmount, short reason, not agreed yet, contract no longer active', opts, async () => {
	const s = await svc(); const w = await world(); const notYet: any = await s.create(w.V.c, w.contract.id, { reason: 'سبب الإلغاء' });
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: 1, expectedHeldAmount: 20, reason: 'سبب كاف للتسوية' })), 409, 'pending (not agreed) cannot be settled');
	await s.respond(w.V.p, notYet.id, 'accept'); const before = JSON.stringify(await money(w));
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: 21, expectedHeldAmount: 20, reason: 'سبب كاف للتسوية' })), 400);
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: 1, expectedHeldAmount: 19, reason: 'سبب كاف للتسوية' })), 409);
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: 1, expectedHeldAmount: 20, reason: 'قصير' })), 400);
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: -1, expectedHeldAmount: 20, reason: 'سبب كاف للتسوية' })), 400);
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: 1.005, expectedHeldAmount: 20, reason: 'سبب كاف للتسوية' })), 400);
	assert.equal(JSON.stringify(await money(w)), before);
	await w.prisma.contract.update({ where: { id: w.contract.id }, data: { status: 'COMPLETED' } });
	assert.equal(await code(s.settle(w.sa.id, notYet.id, { releaseToProvider: 1, expectedHeldAmount: 20, reason: 'سبب كاف للتسوية' })), 409);
});

test('pg: duplicate confirm and two admins at once settle ONCE (one refund transaction, one set of balances)', opts, async () => {
	const s = await svc(); const w = await world(); const id = await agree(w); const a2 = await staff(w, FIN);
	const input = { releaseToProvider: 6, expectedHeldAmount: 20, reason: 'قرار موحّد للتسوية' };
	const res = await Promise.all([code(s.settle(w.sa.id, id, input)), code(s.settle(a2.id, id, input)), code(s.settle(w.sa.id, id, input)), code(s.settle(a2.id, id, { ...input, releaseToProvider: 7 }))]);
	assert.equal(res.filter(x => x === 200).length >= 1, true, JSON.stringify(res)); assert.ok(res.every(x => x === 200 || x === 409), JSON.stringify(res));
	const m = await money(w); assert.equal(m.wtx.length, 1, 'exactly one refund transaction');
	assert.ok(m.client === 14 || m.client === 13, 'refund is 14 (share 6) or 13 (share 7): one of the two, never both'); assert.equal(r2(m.escrow.releasedAmount), r2(20 - m.client));
	const again: any = await s.settle(w.sa.id, id, { ...input, releaseToProvider: r2(20 - m.client) }); assert.equal(again.replayed, true); assert.equal((await money(w)).wtx.length, 1);
});

test('pg: failure injected AFTER the money moved rolls EVERYTHING back; the request stays AGREED_PENDING_SETTLEMENT and a later confirm works', opts, async () => {
	const s = await svc(); const w = await world(); const id = await agree(w); const before = JSON.stringify(await money(w));
	await assert.rejects(() => s.settle(w.sa.id, id, { releaseToProvider: 5, expectedHeldAmount: 20, reason: 'قرار سيفشل تنفيذه' }, { afterMoney: () => { throw new Error('injected'); } }), /injected/);
	assert.equal(JSON.stringify(await money(w)), before, 'no partial movement'); assert.equal((await w.prisma.contractCancellationRequest.findUnique({ where: { id } })).status, 'AGREED_PENDING_SETTLEMENT');
	assert.equal(((await s.settle(w.sa.id, id, { releaseToProvider: 5, expectedHeldAmount: 20, reason: 'قرار ناجح للتسوية' })) as any).status, 'SETTLED');
});

test('pg: settlement vs a stage approval in flight and vs a financial dispute decision never double-pay (serialised by the contract lock)', opts, async () => {
	const s = await svc();
	for (let i = 0; i < 6; i++) {
		// approval vs agreement
		const a = await world({ submitted: true }); const r: any = await s.create(a.V.c, a.contract.id, { reason: 'اتفاق على الإلغاء' });
		const [ap, ag] = await Promise.all([code(projectProgressService.reviewDelivery(a.client.id, a.contract.id, a.s1.id, 'approve')), code(s.respond(a.V.p, r.id, 'accept'))]);
		const e = await a.prisma.escrow.findUnique({ where: { id: a.escrow.id } });
		if (ap === 200) assert.equal(e.releasedAmount, 10, 'approved first: stage paid once'); else { assert.equal(ap, 423); assert.equal(e.releasedAmount, 0); }
		assert.equal(ag, 200);
		// settlement vs approval: after agreement an approval is always refused
		const b = await world({ submitted: true }); const id = await agree(b);
		const [st, ap2] = await Promise.all([code(s.settle(b.sa.id, id, { releaseToProvider: 3, expectedHeldAmount: 20, reason: 'تسوية متزامنة' })), code(projectProgressService.reviewDelivery(b.client.id, b.contract.id, b.s1.id, 'approve'))]);
		assert.equal(st, 200); assert.ok(ap2 === 423 || ap2 === 409, String(ap2)); const eb = await b.prisma.escrow.findUnique({ where: { id: b.escrow.id } }); assert.equal(r2(eb.releasedAmount), 3);
		// settlement vs financial dispute decision: exactly one wins
		const c = await world(); const cid = await agree(c);
		const d = await c.prisma.dispute.create({ data: { id: randomUUID(), projectId: c.project.id, openedById: c.client.id, againstUserId: c.provider.id, reason: 'x', description: 'y'.repeat(30), status: 'OPEN' } });
		const { disputeService } = await import('./dispute.service');
		const [s1, d1] = await Promise.all([code(s.settle(c.sa.id, cid, { releaseToProvider: 4, expectedHeldAmount: 20, reason: 'تسوية متزامنة' })), code(disputeService.resolveFinancial(d.id, c.sa.id, { outcome: 'SPLIT', refundToClient: 16, releaseToProvider: 4, expectedHeldAmount: 20, resolutionNote: 'قرار نزاع متزامن مع التسوية' } as any))]);
		assert.equal(d1, 200, 'the dispute decision (an OPEN dispute) wins'); assert.ok(s1 === 423 || s1 === 409, 'the settlement is refused (423 while the dispute is open, 409 once the dispute closed the contract): ' + s1);
		assert.equal(await code(s.settle(c.sa.id, cid, { releaseToProvider: 4, expectedHeldAmount: 20, reason: 'تسوية بعد قرار النزاع' })), 409, 'after the dispute settled the money the contract is closed');
		const wtx = await c.prisma.walletTransaction.count({ where: { userId: c.client.id } }); assert.ok(wtx <= 1, 'never two refunds'); const ec = await c.prisma.escrow.findUnique({ where: { id: c.escrow.id } }); assert.ok(r2(ec.releasedAmount) <= 4, 'never more than the remainder paid');
	}
});

test('pg: an OPEN dispute blocks the settlement (the dispute is decided first); agreement/settlement leave the dispute table alone', opts, async () => {
	const s = await svc(); const w = await world(); const id = await agree(w);
	await w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, reason: 'x', description: 'y'.repeat(30), status: 'OPEN' } });
	assert.equal(await code(s.settle(w.sa.id, id, { releaseToProvider: 1, expectedHeldAmount: 20, reason: 'سبب كاف للتسوية' })), 423);
	assert.equal((await s.getForAdmin(id, w.sa.id) as any).settlementPreview.canSettle, false);
});

test('pg: views - parties see the new state, settlement amounts and frozen flag; admin preview lists paid / unpaid stages and the real remainder', opts, async () => {
	const s = await svc(); const w = await world({ released: 10 }); const id = await agree(w);
	const pv: any = (await s.listForContract(w.V.p, w.contract.id)).requests[0]; assert.equal(pv.status, 'AGREED_PENDING_SETTLEMENT'); assert.equal(pv.statusLabel, 'تم الاتفاق — بانتظار التسوية'); assert.equal(pv.frozen, true);
	const a: any = await s.getForAdmin(id, w.sa.id); const sp = a.settlementPreview;
	assert.equal(sp.paidStagesTotal, 10); assert.equal(sp.unapprovedStagesTotal, 10); assert.equal(sp.heldAmount, 10); assert.equal(sp.escrowReleased, 10); assert.equal(sp.stages.filter((x: any) => x.paid).length, 1); assert.equal(sp.canSettle, true); assert.equal(sp.commissionRatePercent, 12.75);
	await s.settle(w.sa.id, id, { releaseToProvider: 2.5, expectedHeldAmount: 10, reason: 'تسوية بعد مرحلة واحدة' });
	const cv: any = (await s.listForContract(w.V.c, w.contract.id)).requests[0]; assert.equal(cv.status, 'SETTLED'); assert.equal(cv.settlement.refundToClient, 7.5); assert.equal(cv.frozen, false);
});
