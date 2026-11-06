import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Wallet unification (display + data linking): REAL PostgreSQL (isolated local :55432, database qa_iso_wu*) + the REAL client / provider / marketer routers and services over HTTP.
 * Replaced: `authenticate` only (user id from a header, user loaded from the DB). Role gates, owner scoping, builders, paging are production code.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432, database qa_iso_wu) to run' };
process.env.RATE_LIMIT_ENABLED = 'false'; process.env.JWT_SECRET ??= 'test-secret'; process.env.FRONTEND_URL ??= 'https://front.test';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

let ctx: Promise<any> | null = null;
async function env() {
	if (ctx) return ctx;
	ctx = (async () => {
		const { prisma } = await import('../config/db');
		const realAuth = await import('../middlewares/auth.middleware');
		mock.module('../middlewares/auth.middleware', { namedExports: { ...realAuth, authenticate: async (req: any, res: any, next: any) => {
			const id = req.headers['x-test-user']; const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
			if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
			req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' }; next();
		} } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const clientFinance = (await import('./client-finance.routes')).default;
		const provider = (await import('./provider.routes')).default;
		const marketer = (await import('./marketer-overview.routes')).default;
		const app = express(); app.use(express.json());
		app.use('/client/finance', clientFinance); app.use('/provider', provider); app.use('/marketer-overview', marketer);
		app.use(globalErrorHandler as any);
		const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (url: string, who?: string | null) => {
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { connection: 'close', ...(who ? { 'x-test-user': who } : {}) } });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
			return { status: res.status, json };
		};
		return { prisma, call, server };
	})();
	return ctx;
}
after(async () => { if (ctx) { const e = await ctx; e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } });

const MISSING = 'تفاصيل الخصم غير مسجّلة';
const uid = () => randomUUID();
async function mkUser(prisma: any, accountType: any, role: any, label: string) {
	return prisma.user.create({ data: { id: uid(), accountType, status: 'ACTIVE', roles: [role], activeRole: role, firstName: 'QA', lastName: label, email: `qa-${label}-${uid().slice(0, 8)}@pg.test`, walletBalance: 0 } as any });
}
async function mkProject(prisma: any, client: any, provider: any, price: number, escrow: Record<string, any>, stages: Array<{ amount: number; status: any; approvedAt?: Date }>) {
	const project = await prisma.project.create({ data: { id: uid(), title: `QA-wallet-${uid().slice(0, 6)}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: uid(), projectId: project.id, clientId: client.id, providerId: provider.id, price, durationDays: 14, phasesCount: stages.length, status: 'ACTIVE', signedAt: new Date() } });
	const esc = await prisma.escrow.create({ data: { id: uid(), projectId: project.id, amount: price, status: 'HELD', paymentMethod: 'WALLET', paymentReference: `PG-${uid().slice(0, 8)}`, fundedAt: new Date(), ...escrow } });
	const rows: any[] = [];
	for (const [i, s] of stages.entries()) rows.push(await prisma.projectStage.create({ data: { id: uid(), contractId: contract.id, stepOrder: i + 1, title: `مرحلة ${i + 1}`, days: 7, percentage: 100 / stages.length, amount: s.amount, status: s.status, approvedAt: s.approvedAt ?? null } }));
	return { project, contract, escrow: esc, stages: rows };
}

test('pg client: deposit with fee shows gross → fee → net; OLD deposit without details says so; cards; paging; detail owner-only; no other currency summed', opts, async () => {
	const e = await env(); const { prisma, call } = e;
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'cl'); const outsider = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'out');
	await prisma.user.update({ where: { id: client.id }, data: { walletBalance: 95 } });
	const base = Date.now();
	const dep = await prisma.walletTransaction.create({ data: { userId: client.id, type: 'DEPOSIT', amount: 95, currency: 'USD', paymentMethod: 'PAYPAL', referenceId: `cap-${uid()}`, description: 'x', createdAt: new Date(base - 1000), metadata: { feePolicyVersion: 2, netCredited: 95, grossCharged: 100, feePercent: 5, feeAmount: 5 } } });
	const old = await prisma.walletTransaction.create({ data: { userId: client.id, type: 'DEPOSIT', amount: 40, currency: 'USD', paymentMethod: 'PAYPAL', referenceId: `cap-${uid()}`, createdAt: new Date(base - 2000), metadata: { paypalPaymentId: 'p' } } });
	const sar = await prisma.walletTransaction.create({ data: { userId: client.id, type: 'DEPOSIT', amount: 30, currency: 'SAR', paymentMethod: 'MOYASAR_CARD', referenceId: `cap-${uid()}`, createdAt: new Date(base - 3000), metadata: { feePolicyVersion: 2, netCredited: 30, grossCharged: 31, feePercent: 3, feeAmount: 1 } } });
	const w = await call('/client/finance/wallet', client.id); assert.equal(w.status, 200, JSON.stringify(w.json));
	const rows = w.json.data.transactions; const depRow = rows.find((r: any) => r.id === dep.id);
	assert.deepEqual({ g: depRow.breakdown.gross, n: depRow.breakdown.net, f: depRow.breakdown.deductions[0].amount, c: depRow.breakdown.deductions[0].code, p: depRow.breakdown.deductions[0].ratePercent, lv: depRow.breakdown.deductions[0].level }, { g: 100, n: 95, f: 5, c: 'PAYPAL_DEPOSIT_FEE', p: 5, lv: null });
	const oldRow = rows.find((r: any) => r.id === old.id); assert.equal(oldRow.breakdown.detailsRecorded, false); assert.equal(oldRow.breakdown.missingNote, MISSING); assert.equal(oldRow.breakdown.gross, null); assert.equal(oldRow.breakdown.deductions.length, 0);
	const cards = w.json.data.summary.cards;
	assert.equal(cards.availableBalance.value, 95); assert.equal(cards.cashback.state, 'NOT_ENABLED'); assert.equal(cards.cashback.value, null);
	assert.equal(cards.grossBeforeDeductions.value, 100); assert.equal(cards.grossBeforeDeductions.operationsWithoutDetails, 1); assert.equal(cards.grossBeforeDeductions.excludedOtherCurrency, 1); assert.equal(cards.grossBeforeDeductions.complete, false);
	assert.equal(w.json.data.summary.canWithdraw, false);
	// existing fields untouched
	assert.equal(w.json.data.summary.availableBalance, 95); assert.equal(w.json.data.summary.currency, 'USD');
	// paging
	const p1 = await call('/client/finance/wallet/history?page=1&limit=2', client.id); assert.equal(p1.status, 200);
	assert.equal(p1.json.data.items.length, 2); assert.equal(p1.json.data.pagination.total, 3); assert.equal(p1.json.data.pagination.totalPages, 2); assert.equal(p1.json.data.items[0].id, dep.id);
	const p2 = await call('/client/finance/wallet/history?page=2&limit=2', client.id); assert.equal(p2.json.data.items.length, 1); assert.equal(p2.json.data.items[0].id, sar.id);
	assert.equal(p2.json.data.items[0].breakdown.currency, 'SAR');
	const only = await call('/client/finance/wallet/history?type=REFUND', client.id); assert.equal(only.json.data.pagination.total, 0);
	// direct detail: owner vs another account vs anonymous vs unknown
	const mine = await call(`/client/finance/wallet/transactions/${dep.id}`, client.id); assert.equal(mine.status, 200); assert.equal(mine.json.data.breakdown.net, 95);
	assert.equal((await call(`/client/finance/wallet/transactions/${dep.id}`, outsider.id)).status, 404);
	assert.equal((await call(`/client/finance/wallet/transactions/${dep.id}`)).status, 401);
	assert.equal((await call('/client/finance/wallet/transactions/nope', client.id)).status, 404);
	assert.equal((await call('/client/finance/wallet/history', outsider.id)).json.data.items.length, 0);
});

test('pg client: empty history, held escrow card, v2 escrow lock = no fee, legacy escrow lock = details not recorded', opts, async () => {
	const { prisma, call } = await env();
	const empty = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'empty');
	const r = await call('/client/finance/wallet/history', empty.id); assert.equal(r.status, 200);
	assert.deepEqual({ n: r.json.data.items.length, t: r.json.data.pagination.total, tp: r.json.data.pagination.totalPages }, { n: 0, t: 0, tp: 0 });
	assert.equal(r.json.data.summary.cards.grossBeforeDeductions.value, 0); assert.equal(r.json.data.summary.cards.grossBeforeDeductions.operationsCounted, 0);
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'held'); const prov = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'hp');
	const v2 = await mkProject(prisma, client, prov, 100, { feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, releasedAmount: 20 }, [{ amount: 100, status: 'PENDING' }]);
	const legacy = await mkProject(prisma, client, prov, 50, {}, [{ amount: 50, status: 'PENDING' }]);
	const w = await call('/client/finance/wallet', client.id);
	assert.equal(w.json.data.summary.cards.heldInEscrow.value, 130); // 80 left of v2 + 50 legacy
	const rows = w.json.data.transactions;
	const v2Row = rows.find((x: any) => x.id === `escrow-${v2.escrow.id}`); const lgRow = rows.find((x: any) => x.id === `escrow-${legacy.escrow.id}`);
	assert.equal(v2Row.breakdown.detailsRecorded, true); assert.equal(v2Row.breakdown.net, 100); assert.equal(v2Row.breakdown.deductions.length, 0);
	assert.equal(lgRow.breakdown.detailsRecorded, false); assert.equal(lgRow.breakdown.missingNote, MISSING);
	// a legacy wallet ESCROW_LOCK stores a NEGATIVE amount: amount stays as stored, displayAmount is absolute, direction says HOLD
	await prisma.walletTransaction.create({ data: { userId: client.id, type: 'ESCROW_LOCK', amount: -150, currency: 'USD', paymentMethod: 'WALLET', referenceId: `ESCROW-${uid()}`, metadata: {} } });
	const neg = (await call('/client/finance/wallet/history', client.id)).json.data.items.find((x: any) => x.amount === -150);
	assert.deepEqual({ d: neg.displayAmount, dir: neg.direction, g: neg.breakdown.detailsRecorded }, { d: 150, dir: 'HOLD', g: false });
	const det = await call(`/client/finance/wallet/transactions/escrow-${v2.escrow.id}`, client.id); assert.equal(det.status, 200); assert.equal(det.json.data.breakdown.operation, 'ESCROW_LOCK');
	assert.equal((await call(`/client/finance/wallet/transactions/escrow-${v2.escrow.id}`, empty.id)).status, 404);
	// a provider acting as provider cannot reach the client wallet
	assert.equal((await call('/client/finance/wallet/history', prov.id)).status, 403);
});

test('pg provider: stage release shows gross → commission(rate+level recorded) → net, never re-priced by the current level; cards = what the withdrawal path accepts; pending withdrawal; held escrow', opts, async () => {
	const { prisma, call } = await env();
	const { splitRelease } = await import('../utils/escrow-commission');
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'c2'); const prov = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'p2'); const other = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'p3');
	const t0 = new Date(Date.now() - 86_400_000);
	const s1 = splitRelease({ grossReleasedBefore: 0, commissionTotalBefore: 0, grossReleasedAfter: 40, ratePercent: 12.75 }); // commission 5.1
	const w = await mkProject(prisma, client, prov, 100, { feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 3, releasedAmount: s1.grossReleasedAfter, platformCommissionAmount: s1.commissionTotalAfter, providerNetReleasedAmount: s1.netReleasedAfter },
		[{ amount: 40, status: 'APPROVED', approvedAt: t0 }, { amount: 60, status: 'IN_PROGRESS' }]);
	// the provider is level 9 NOW (a different rate): the recorded one must still be shown
	await prisma.providerGamification.upsert({ where: { providerId: prov.id }, create: { providerId: prov.id, currentLevelIndex: 9 } as any, update: { currentLevelIndex: 9 } }).catch(() => undefined);
	await prisma.withdrawal.create({ data: { userId: prov.id, amount: 10, currency: 'USD', method: 'paypal', status: 'PENDING', referenceId: `W-${uid()}` } });
	const r = await call('/provider/finance/wallet', prov.id); assert.equal(r.status, 200, JSON.stringify(r.json));
	const sm = r.json.data.summary; const stageId = w.stages[0].id;
	const row = r.json.data.transactions.find((x: any) => x.id === `stage-release-${stageId}`);
	assert.equal(row.amount, s1.net); // existing field unchanged
	assert.deepEqual({ g: row.breakdown.gross, n: row.breakdown.net, c: row.breakdown.deductions[0].amount, code: row.breakdown.deductions[0].code, rate: row.breakdown.deductions[0].ratePercent, lv: row.breakdown.deductions[0].level, rec: row.breakdown.deductions[0].levelRecorded }, { g: 40, n: s1.net, c: s1.commission, code: 'PLATFORM_PROVIDER_COMMISSION', rate: 12.75, lv: 3, rec: true });
	assert.equal(sm.cards.availableToWithdraw.value, sm.withdrawableBalance); assert.equal(sm.withdrawableBalance, Math.round((s1.net - 10) * 100) / 100);
	assert.equal(sm.cards.pendingWithdrawals.value, 10); assert.equal(sm.cards.grossBeforeDeductions.value, 40); assert.equal(sm.cards.grossBeforeDeductions.complete, true);
	assert.equal(sm.cards.heldInEscrow.value, sm.escrowBalance); assert.equal(sm.cards.cashback.state, 'NOT_APPLICABLE'); assert.equal(sm.canWithdraw, true); assert.equal(typeof sm.minimumWithdrawal, 'number');
	// the figure the withdrawal path enforces: asking for more than withdrawable is refused with that same number
	const { withdrawalService } = await import('../services/withdrawal.service');
	await assert.rejects(() => withdrawalService.createForProvider(prov.id, { amount: sm.withdrawableBalance + 0.01, method: 'paypal' } as any));
	// paged history + detail, owner only
	const h = await call('/provider/finance/history?limit=1&page=1', prov.id); assert.equal(h.status, 200); assert.equal(h.json.data.pagination.total, 2); // release + funding event
	const f = await call('/provider/finance/history?type=ESCROW_FUNDED', prov.id); assert.equal(f.json.data.items.length, 1); assert.equal(f.json.data.items[0].breakdown.netMeaning, 'HELD');
	const d = await call(`/provider/finance/transactions/stage-release-${stageId}`, prov.id); assert.equal(d.status, 200); assert.equal(d.json.data.breakdown.net, s1.net); assert.equal(d.json.data.project.id, w.project.id);
	assert.equal((await call(`/provider/finance/transactions/stage-release-${stageId}`, other.id)).status, 404);
	assert.equal((await call(`/provider/finance/transactions/stage-release-${stageId}`, client.id)).status, 403);
	assert.equal((await call(`/provider/finance/transactions/stage-release-${stageId}`)).status, 401);
	assert.equal((await call('/provider/finance/history', other.id)).json.data.items.length, 0);
	// the old unpaged list is unchanged in shape
	const old = await call('/provider/finance/transactions', prov.id); assert.equal(old.status, 200); assert.ok(Array.isArray(old.json.data.events));
});

test('pg provider: OLD v2 escrow without a rate snapshot -> details not recorded; legacy escrow -> no provider deduction; no-transactions state', opts, async () => {
	const { prisma, call } = await env();
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'c3'); const prov = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'p4'); const none = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'p5');
	const empty = await call('/provider/finance/history', none.id); assert.equal(empty.status, 200); assert.equal(empty.json.data.pagination.total, 0);
	assert.equal(empty.json.data.summary.cards.availableToWithdraw.value, 0);
	const t0 = new Date(Date.now() - 3_600_000);
	const noSnap = await mkProject(prisma, client, prov, 50, { feePolicyVersion: 2, releasedAmount: 50, providerNetReleasedAmount: 44 }, [{ amount: 50, status: 'APPROVED', approvedAt: t0 }]);
	const legacy = await mkProject(prisma, client, prov, 30, { releasedAmount: 30 }, [{ amount: 30, status: 'APPROVED', approvedAt: new Date(t0.getTime() - 1000) }]);
	const r = await call('/provider/finance/wallet', prov.id); assert.equal(r.status, 200, JSON.stringify(r.json));
	const a = r.json.data.transactions.find((x: any) => x.id === `stage-release-${noSnap.stages[0].id}`); const b = r.json.data.transactions.find((x: any) => x.id === `stage-release-${legacy.stages[0].id}`);
	assert.equal(a.breakdown.detailsRecorded, false); assert.equal(a.breakdown.missingNote, MISSING); assert.equal(a.breakdown.gross, null); assert.equal(a.breakdown.deductions.length, 0);
	assert.equal(b.breakdown.detailsRecorded, true); assert.equal(b.breakdown.gross, 30); assert.equal(b.breakdown.net, 30); assert.equal(b.breakdown.deductions.length, 0);
	const c = r.json.data.summary.cards.grossBeforeDeductions; assert.equal(c.value, 30); assert.equal(c.operationsWithoutDetails, 1); assert.equal(c.complete, false);
});

test('pg provider: mutual-cancellation settlement line shows gross -> commission -> net with the escrow-recorded rate; and the amounts balance with availableBalance', opts, async () => {
	const { prisma, call } = await env();
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'c4'); const prov = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'p6');
	// 100 contract, 40 released by a stage (net 34.9), then a settlement released 30 more to the provider (commission 3.83 => net 26.17), 30 refunded to the client
	const rate = 12.75; const stage = 40; const settle = 30;
	const first = 40 - Math.round(40 * rate) / 100; const total = 70; const totalCommission = Math.round(total * rate) / 100; const settleCommission = Math.round((totalCommission - (40 - first)) * 100) / 100; const settleNet = Math.round((settle - settleCommission) * 100) / 100;
	const w = await mkProject(prisma, client, prov, 100, { status: 'RELEASED', feePolicyVersion: 2, providerCommissionRateSnapshot: rate, providerCommissionLevelSnapshot: 2, releasedAmount: total, platformCommissionAmount: totalCommission, providerNetReleasedAmount: Math.round((total - totalCommission) * 100) / 100 }, [{ amount: stage, status: 'APPROVED', approvedAt: new Date(Date.now() - 5000) }]);
	const req = await prisma.contractCancellationRequest.create({ data: { contractId: w.contract.id, projectId: w.project.id, clientId: client.id, providerId: prov.id, requestedById: client.id, requestedByRole: 'CLIENT', reason: 'x', status: 'SETTLED', settlementStatus: 'SETTLED' as any, settledAt: new Date(), settlementHeldBefore: 60, settlementRefundToClient: 30, settlementReleaseToProvider: settle, settlementPlatformCommission: settleCommission, settlementProviderNet: settleNet } as any });
	const r = await call('/provider/finance/wallet', prov.id); assert.equal(r.status, 200, JSON.stringify(r.json));
	const line = r.json.data.transactions.find((x: any) => x.id === `cancellation-settlement-${req.id}`);
	assert.ok(line, 'history line id cancellation-settlement-<id>'); assert.equal(line.amount, settleNet); assert.equal(line.category, 'CANCELLATION_SETTLEMENT');
	assert.deepEqual({ g: line.breakdown.gross, n: line.breakdown.net, c: line.breakdown.deductions[0].amount, rate: line.breakdown.deductions[0].ratePercent, lv: line.breakdown.deductions[0].level, op: line.breakdown.operation }, { g: settle, n: settleNet, c: settleCommission, rate, lv: 2, op: 'CANCELLATION_SETTLEMENT' });
	const sm = r.json.data.summary; assert.equal(sm.releasedWithoutLine, 0); assert.equal(sm.cards.grossBeforeDeductions.value, 70); assert.equal(sm.cards.grossBeforeDeductions.complete, true);
	assert.equal(sm.cards.heldInEscrow.value, 0); // RELEASED escrow holds nothing
	const d = await call(`/provider/finance/transactions/cancellation-settlement-${req.id}`, prov.id); assert.equal(d.status, 200); assert.equal(d.json.data.breakdown.net, settleNet);
	assert.equal((await call(`/provider/finance/transactions/cancellation-settlement-${req.id}`, client.id)).status, 403);
});

test('pg provider: an escrow released outside any line (dispute) is reported, not hidden', opts, async () => {
	const { prisma, call } = await env();
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'c5'); const prov = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'p7');
	await mkProject(prisma, client, prov, 100, { status: 'RELEASED', feePolicyVersion: 2, providerCommissionRateSnapshot: 10, providerCommissionLevelSnapshot: 1, releasedAmount: 100, platformCommissionAmount: 10, providerNetReleasedAmount: 90 }, [{ amount: 100, status: 'PENDING' }]);
	const r = await call('/provider/finance/wallet', prov.id); const sm = r.json.data.summary;
	assert.equal(sm.releasedWithoutLine, 90); assert.equal(sm.cards.grossBeforeDeductions.complete, false); assert.equal(sm.cards.availableToWithdraw.value, 90);
});

test('pg marketer: cards use the withdrawal-enforced figure; commission history with recorded rate/level; withdrawal line; owner only', opts, async () => {
	const { prisma, call } = await env();
	const mk = await mkUser(prisma, 'MARKETING_BROKER', 'AFFILIATE', 'mk'); const other = await mkUser(prisma, 'MARKETING_BROKER', 'AFFILIATE', 'mk2'); const referred = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'rf');
	const aff = await prisma.affiliateProfile.create({ data: { userId: mk.id, referralSlug: `s-${uid().slice(0, 8)}` } as any });
	await prisma.affiliateProfile.create({ data: { userId: other.id, referralSlug: `s-${uid().slice(0, 8)}` } as any });
	const ref = await prisma.referral.create({ data: { affiliateId: aff.id, referredUserId: referred.id } });
	const c1 = await prisma.commissionLog.create({ data: { affiliateId: aff.id, referralId: ref.id, referredUserId: referred.id, baseAmount: 200, appliedPercentage: 5, level: 2, type: 'FIRST_PROJECT_COMPLETED', amount: 10, currency: 'USD', status: 'APPROVED' } as any });
	await prisma.commissionLog.create({ data: { affiliateId: aff.id, referralId: ref.id, referredUserId: referred.id, baseAmount: 100, appliedPercentage: 5, level: 2, type: 'SUBSCRIPTION', amount: 5, currency: 'USD', status: 'PENDING' } as any });
	const wd = await prisma.withdrawal.create({ data: { userId: mk.id, amount: 4, currency: 'USD', method: 'paypal', status: 'PENDING', referenceId: `W-${uid()}` } });
	const w = await call('/marketer-overview/wallet', mk.id); assert.equal(w.status, 200, JSON.stringify(w.json));
	assert.equal(w.json.data.cards.availableToWithdraw.value, w.json.data.withdrawableBalance); assert.equal(w.json.data.withdrawableBalance, 6);
	assert.equal(w.json.data.cards.pendingWithdrawals.value, 4); assert.equal(w.json.data.cards.grossBeforeDeductions.value, 10); assert.equal(w.json.data.cards.heldInEscrow.state, 'UNAVAILABLE'); assert.equal(w.json.data.pendingEarnings, 5);
	const h = await call('/marketer-overview/wallet/history?limit=10', mk.id); assert.equal(h.status, 200, JSON.stringify(h.json)); assert.equal(h.json.data.pagination.total, 3);
	const c = h.json.data.items.find((x: any) => x.id === `commission-${c1.id}`);
	assert.deepEqual({ g: c.breakdown.gross, n: c.breakdown.net, d: c.breakdown.deductions.length, rec: c.breakdown.detailsRecorded }, { g: 10, n: 10, d: 0, rec: true }); assert.match(c.breakdown.note, /5% من 200/); assert.match(c.breakdown.note, /المستوى 2/);
	const wl = h.json.data.items.find((x: any) => x.id === `withdrawal-${wd.id}`); assert.equal(wl.breakdown.netMeaning, 'DEBITED_FROM_WALLET'); assert.equal(wl.status, 'PENDING'); assert.equal(wl.breakdown.note, 'الحالة: بانتظار مراجعة الإدارة'); assert.ok(!/PENDING/.test(wl.breakdown.note));
	assert.equal((await call(`/marketer-overview/wallet/history/commission-${c1.id}`, mk.id)).status, 200);
	assert.equal((await call(`/marketer-overview/wallet/history/commission-${c1.id}`, other.id)).status, 404);
	assert.equal((await call(`/marketer-overview/wallet/history/withdrawal-${wd.id}`, other.id)).status, 404);
	assert.equal((await call('/marketer-overview/wallet/history', referred.id)).status, 403);
	assert.equal((await call('/marketer-overview/wallet/history?type=WITHDRAWAL', mk.id)).json.data.items.length, 1);
	assert.equal((await call('/marketer-overview/wallet/history', other.id)).json.data.pagination.total, 0);
});

test('pg paging beyond one page: 25 client rows and 22 provider rows, both pages, no duplicates and no gaps', opts, async () => {
	const { prisma, call } = await env();
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'pg25'); const prov = await mkUser(prisma, 'PROVIDER_COMPANY', 'PROVIDER', 'pg22');
	const base = Date.now();
	for (let i = 0; i < 25; i++) await prisma.walletTransaction.create({ data: { userId: client.id, type: 'REFUND', amount: 1 + i, currency: 'USD', referenceId: `pg-${uid()}`, createdAt: new Date(base - i * 1000) } });
	const all: string[] = [];
	for (const page of [1, 2, 3]) { const r = await call(`/client/finance/wallet/history?page=${page}&limit=20`, client.id); assert.equal(r.json.data.pagination.total, 25); assert.equal(r.json.data.pagination.totalPages, 2); all.push(...r.json.data.items.map((x: any) => x.id)); if (page === 1) assert.equal(r.json.data.items.length, 20); if (page === 2) assert.equal(r.json.data.items.length, 5); if (page === 3) assert.equal(r.json.data.items.length, 0); }
	assert.equal(all.length, 25); assert.equal(new Set(all).size, 25);
	const full = (await call('/client/finance/wallet', client.id)).json.data.transactions.map((x: any) => x.id); assert.deepEqual(all, full); // same order as the wallet list
	const stages = Array.from({ length: 22 }, (_, i) => ({ amount: 10, status: 'APPROVED' as const, approvedAt: new Date(base - i * 1000) }));
	await mkProject(prisma, client, prov, 220, { feePolicyVersion: 2, providerCommissionRateSnapshot: 10, providerCommissionLevelSnapshot: 1, releasedAmount: 220, platformCommissionAmount: 22, providerNetReleasedAmount: 198, status: 'RELEASED' }, stages);
	const ids: string[] = [];
	for (const page of [1, 2]) { const r = await call(`/provider/finance/history?page=${page}&limit=20`, prov.id); assert.equal(r.status, 200); assert.equal(r.json.data.pagination.total, 23); ids.push(...r.json.data.items.map((x: any) => x.id)); }
	assert.equal(ids.length, 23); assert.equal(new Set(ids).size, 23);
});

test('pg individual provider: wallet / history / details reachable once a specialty is APPROVED; PROVIDER_DASHBOARD_LOCKED unchanged before; old /transactions list unchanged', opts, async () => {
	const { prisma, call } = await env();
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'CLIENT', 'ci'); const prov = await mkUser(prisma, 'PROVIDER_INDIVIDUAL', 'PROVIDER', 'pi');
	for (const url of ['/provider/finance/wallet', '/provider/finance/history', '/provider/finance/transactions/x', '/provider/finance/transactions']) { const r = await call(url, prov.id); assert.equal(r.status, 403, url); assert.equal(r.json.code, 'PROVIDER_DASHBOARD_LOCKED', url); }
	const tag = uid().slice(0, 6);
	const cat = await prisma.category.create({ data: { id: uid(), slug: `c-${tag}`, nameAr: 'تصنيف' } }); const spec = await prisma.specialty.create({ data: { id: uid(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const pp = await prisma.providerProfile.create({ data: { id: uid(), userId: prov.id } });
	const ps = await prisma.providerSpecialty.create({ data: { id: uid(), providerProfileId: pp.id, specialtyId: spec.id, subSpecialties: [], status: 'PENDING_PROOF' } });
	assert.equal((await call('/provider/finance/history', prov.id)).status, 403); // not approved yet
	const w = await mkProject(prisma, client, prov, 100, { feePolicyVersion: 2, providerCommissionRateSnapshot: 10, providerCommissionLevelSnapshot: 2, releasedAmount: 40, platformCommissionAmount: 4, providerNetReleasedAmount: 36 }, [{ amount: 40, status: 'APPROVED', approvedAt: new Date() }, { amount: 60, status: 'IN_PROGRESS' }]);
	await prisma.providerSpecialty.update({ where: { id: ps.id }, data: { status: 'APPROVED' } });
	const wal = await call('/provider/finance/wallet', prov.id); assert.equal(wal.status, 200, JSON.stringify(wal.json)); assert.equal(wal.json.data.summary.cards.availableToWithdraw.value, 36);
	const hist = await call('/provider/finance/history', prov.id); assert.equal(hist.status, 200); assert.equal(hist.json.data.pagination.total, 2);
	const det = await call(`/provider/finance/transactions/stage-release-${w.stages[0].id}`, prov.id); assert.equal(det.status, 200); assert.equal(det.json.data.breakdown.deductions[0].level, 2);
	assert.equal((await call(`/provider/finance/transactions/stage-release-${w.stages[0].id}`, client.id)).status, 403);
	// the old unpaged list (the only export-style consumer of /transactions) keeps its shape: summary + events, each event with its old fields
	const old = await call('/provider/finance/transactions', prov.id); assert.equal(old.status, 200); assert.deepEqual(Object.keys(old.json.data).sort(), ['events', 'summary']);
	for (const k of ['id', 'type', 'category', 'amount', 'currency', 'title', 'description', 'projectId', 'status', 'createdAt']) assert.ok(k in old.json.data.events[0], k);
});
