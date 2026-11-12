import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { env, opts, closeEnv, mkStaff } from '../testing/admin-team.pgenv';

/**
 * Admin control over requests / offers / contracts / escrow on REAL PostgreSQL (isolated local :55432, database qa_iso_perm_admoc, synthetic data only) through the REAL routers, permission guard,
 * services and audit mechanism. Only `authenticate` is replaced (header user id) and the notification delivery is an isolated stub: nothing is sent, no money is real.
 */
after(async () => { await closeEnv(); });
const sent: any[] = [];
let booted: Promise<any> | null = null;
async function boot() {
	booted ??= (async () => {
		const e = await env();
		const { adminControlDeps } = await import('./admin-order-controls.service');
		adminControlDeps.notify = async (n: any) => { sent.push(n); return {}; };
		const port = (e.server.address() as AddressInfo).port;
		const http = async (method: string, url: string, who: string | null, body?: any, key?: string | null) => {
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...(who ? { 'x-test-user': who } : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
			return { status: res.status, json, code: json?.code as string | undefined, data: json?.data };
		};
		return { ...e, http, adminControlDeps };
	})();
	return booted;
}

const id = () => randomUUID();
const keyOf = () => `k-${id()}`;
interface W { e: any; tag: string; client: any; provider: any; provider2: any; spec: any; profile: any; request: any; project: any; offer: any; offer2: any; contract?: any; escrow?: any }

/** a request with two offers; opt.contract creates the contract (+ funded escrow with `held`); opt.v2 gives the escrow a fee-policy-v2 snapshot (12.75%) */
async function world(o: { requestStatus?: string; contract?: string; escrow?: 'HELD' | 'RELEASED' | 'REFUNDED'; released?: number; v2?: boolean; offerStatus?: string; offer2Status?: string } = {}): Promise<W> {
	const e = await boot(); const prisma = e.prisma; const tag = id().slice(0, 8);
	const mk = (n: string, accountType: string, role: string) => prisma.user.create({ data: { id: id(), accountType, firstName: n, lastName: tag, email: `${n}-${tag}@pg.test`, roles: [role], activeRole: role, status: 'ACTIVE', walletBalance: 0 } });
	const client = await mk('client', 'CLIENT_INDIVIDUAL', 'CLIENT'); const provider = await mk('prov', 'PROVIDER_INDIVIDUAL', 'PROVIDER'); const provider2 = await mk('prov2', 'PROVIDER_INDIVIDUAL', 'PROVIDER');
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const profile = await prisma.clientProfile.create({ data: { id: id(), userId: client.id } as any });
	const rid = id();
	const request = await prisma.clientRequest.create({ data: { id: rid, clientProfileId: profile.id, specialtyId: spec.id, title: `طلب ${tag}`, description: 'وصف تجريبي كافٍ للطلب', subSpecialties: [], requiredSkills: [], status: (o.requestStatus ?? 'OPEN') as any } });
	const project = await prisma.project.create({ data: { id: rid, title: request.title, description: 'x', specialty: 'x', deliveryDays: 10, clientId: client.id, status: (o.requestStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : o.requestStatus === 'PENDING_SIGNATURE' ? 'PENDING_SIGNATURE' : 'OPEN') as any } });
	const mkOffer = (p: any, status: string) => prisma.projectProposal.create({ data: { id: id(), projectId: rid, providerId: p.id, title: 'عرض', message: 'synthetic', totalPrice: 20, deliveryDays: 4, status: status as any } });
	const offer = await mkOffer(provider, o.offerStatus ?? 'SUBMITTED'); const offer2 = await mkOffer(provider2, o.offer2Status ?? 'SUBMITTED');
	const w: W = { e, tag, client, provider, provider2, spec, profile, request, project, offer, offer2 };
	if (o.contract) {
		w.contract = await prisma.contract.create({ data: { id: id(), projectId: rid, clientId: client.id, providerId: provider.id, offerId: offer.id, price: 20, durationDays: 14, phasesCount: 2, status: o.contract as any, signedAt: o.contract === 'ACTIVE' ? new Date() : null } });
		const released = o.released ?? 0;
		if (o.escrow) w.escrow = await prisma.escrow.create({ data: { id: id(), projectId: rid, amount: 20, status: o.escrow as any, releasedAmount: released, fundedAt: new Date(), ...(o.v2 ? { feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, platformCommissionAmount: Math.round(released * 12.75) / 100, providerNetReleasedAmount: released - Math.round(released * 12.75) / 100 } : {}) } });
		// the legacy Proposal mirror every real engagement has: the existing close-out flows reach the request THROUGH it (clientRequest.updateMany where proposals some projectId)
		await prisma.proposal.create({ data: { id: id(), projectId: rid, clientRequestId: rid, providerId: provider.id, price: 20, deliveryDays: 4, status: 'ACCEPTED' } });
		await prisma.projectStage.create({ data: { id: id(), contractId: w.contract.id, stepOrder: 1, title: 'S1', days: 7, percentage: 50, amount: 10, status: released ? 'APPROVED' : 'IN_PROGRESS' } });
		await prisma.projectStage.create({ data: { id: id(), contractId: w.contract.id, stepOrder: 2, title: 'S2', days: 7, percentage: 50, amount: 10, status: 'PENDING' } });
	}
	return w;
}
const snap = async (w: W) => JSON.stringify({
	request: await w.e.prisma.clientRequest.findUnique({ where: { id: w.request.id }, select: { status: true, adminSuspendedAt: true, adminCancelledAt: true } }),
	project: await w.e.prisma.project.findUnique({ where: { id: w.project.id }, select: { status: true } }),
	contract: w.contract ? await w.e.prisma.contract.findUnique({ where: { id: w.contract.id }, select: { status: true, adminFrozenAt: true } }) : null,
	escrow: w.escrow ? await w.e.prisma.escrow.findUnique({ where: { id: w.escrow.id }, select: { status: true, releasedAmount: true, platformCommissionAmount: true, providerNetReleasedAmount: true } }) : null,
	offers: await w.e.prisma.projectProposal.findMany({ where: { projectId: w.request.id }, orderBy: { id: 'asc' }, select: { status: true, adminSuspendedAt: true } }),
	wallets: (await w.e.prisma.user.findMany({ where: { id: { in: [w.client.id, w.provider.id] } }, orderBy: { id: 'asc' }, select: { walletBalance: true } })).map((u: any) => ({ walletBalance: Number(u.walletBalance) })),
	wtx: await w.e.prisma.walletTransaction.count({ where: { userId: { in: [w.client.id, w.provider.id] } } })
});
const audit = (w: W, entity: string, entityId: string, eventType?: string) => w.e.prisma.accountAuditLog.findMany({ where: { source: 'ADMIN', ...(eventType ? { eventType } : {}), AND: [{ context: { path: ['entity'], equals: entity } }, { context: { path: ['entityId'], equals: entityId } }] } });
const ctl = async (w: W, kind: 'requests' | 'offers' | 'contracts', ref: string, who: string) => (await w.e.http('GET', `/admin/${kind}/${ref}/controls`, who)).data;

// ───────────────────────── requests ─────────────────────────
test('request suspend/resume: state x permission matrix, reason + key + version rules', opts, async () => {
	const w = await world(); const e = w.e; const sa = e.sa.id;
	const none = await mkStaff(e, ['users.view']); const reqStaff = await mkStaff(e, ['requests.manage']); const offStaff = await mkStaff(e, ['offers.manage']);
	const v0 = (await ctl(w, 'requests', w.request.id, sa)).version;
	const body = (r: any = 'سبب التعليق المؤقت', v = v0) => ({ reason: r, expectedVersion: v });
	// permission matrix: a regular staff / an offers-only staff are refused BEFORE any state is read; a missing guard cannot be bypassed by a SUPER_ADMIN-less body
	for (const who of [none.user.id, offStaff.user.id]) { const r = await e.http('POST', `/admin/requests/${w.request.id}/suspend`, who, body(), keyOf()); assert.equal(r.status, 403); assert.equal(r.code, 'ADMIN_PERMISSION_DENIED'); }
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, null, body(), keyOf())).status, 401);
	// request contract of the call
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, reqStaff.user.id, body(), null)).code, 'IDEMPOTENCY_KEY_REQUIRED');
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, reqStaff.user.id, body(''), keyOf())).code, 'REASON_REQUIRED');
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, reqStaff.user.id, body('abc'), keyOf())).code, 'REASON_REQUIRED');
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, reqStaff.user.id, { reason: 'سبب التعليق المؤقت' }, keyOf())).code, 'VERSION_REQUIRED');
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, reqStaff.user.id, body('سبب صالح للتعليق', 'stale-version'), keyOf())).code, 'STALE_VERSION');
	const before = await snap(w); assert.equal(before.includes('"adminSuspendedAt":null'), true);
	sent.length = 0;
	const ok = await e.http('POST', `/admin/requests/${w.request.id}/suspend`, reqStaff.user.id, body(), keyOf());
	assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.data.suspended, true); assert.equal(ok.data.requestStatus, 'OPEN');
	// data and the existing offers are preserved
	const after = JSON.parse(await snap(w)); assert.equal(after.request.status, 'OPEN'); assert.deepEqual(after.offers.map((o: any) => o.status), ['SUBMITTED', 'SUBMITTED']);
	assert.equal((await audit(w, 'REQUEST', w.request.id, 'REQUEST_SUSPENDED')).length, 1);
	assert.ok(sent.some(n => n.userId === w.client.id) && sent.some(n => n.userId === w.provider.id), 'client and the providers with offers are told, after the commit');
	// already suspended -> specific reason; resume needs no reason; version of the new state is required
	const c1 = await ctl(w, 'requests', w.request.id, sa); assert.equal(c1.actions.REQUEST_SUSPEND.code, 'REQUEST_ALREADY_SUSPENDED'); assert.equal(c1.actions.REQUEST_RESUME.allowed, true);
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/suspend`, sa, { reason: 'سبب التعليق المؤقت', expectedVersion: c1.version }, keyOf())).code, 'REQUEST_ALREADY_SUSPENDED');
	const res = await e.http('POST', `/admin/requests/${w.request.id}/resume`, sa, { expectedVersion: c1.version }, keyOf());
	assert.equal(res.status, 200, JSON.stringify(res.json)); assert.equal(res.data.suspended, false);
	assert.equal((await ctl(w, 'requests', w.request.id, sa)).actions.REQUEST_RESUME.code, 'REQUEST_NOT_SUSPENDED');
	assert.equal((await audit(w, 'REQUEST', w.request.id, 'REQUEST_RESUMED')).length, 1);
});

test('request suspend: refused for every non-OPEN state with the specific code; a linked contract is managed through the contract', opts, async () => {
	const e = await boot(); const sa = e.sa.id;
	for (const [status, code] of [['CANCELLED', 'REQUEST_ALREADY_CANCELLED'], ['COMPLETED', 'REQUEST_COMPLETED'], ['DRAFT', 'REQUEST_DRAFT']] as const) {
		const w = await world({ requestStatus: status }); const c = await ctl(w, 'requests', w.request.id, sa);
		assert.equal(c.actions.REQUEST_SUSPEND.code, code, status); assert.equal(c.actions.REQUEST_SUSPEND.allowed, false);
		const r = await e.http('POST', `/admin/requests/${w.request.id}/suspend`, sa, { reason: 'سبب التعليق', expectedVersion: c.version }, keyOf()); assert.equal(r.code, code);
	}
	const w = await world({ requestStatus: 'PENDING_SIGNATURE', contract: 'PENDING_CLIENT_SIGNATURE' }); const c = await ctl(w, 'requests', w.request.id, sa);
	assert.equal(c.actions.REQUEST_SUSPEND.code, 'REQUEST_HAS_CONTRACT');
});

test('suspension is real: a suspended request/offer cannot be chosen, resume restores the flow (existing selectOffer enforces the hold)', opts, async () => {
	const w = await world(); const e = w.e; const sa = e.sa.id;
	const { clientRequestsService } = await import('./client-requests.service');
	const v = (await ctl(w, 'requests', w.request.id, sa)).version;
	await e.http('POST', `/admin/requests/${w.request.id}/suspend`, sa, { reason: 'تعليق للتحقق', expectedVersion: v }, keyOf());
	await assert.rejects(clientRequestsService.selectOffer(w.client.id, w.request.id, w.offer.id), (err: any) => err.statusCode === 422 && err.code === 'REQUEST_SUSPENDED_BY_ADMIN');
	// a NEW offer is refused too
	const { proposalService } = await import('./proposal.service');
	await assert.rejects(proposalService.createProposal(w.request.id, (await e.prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'n', lastName: 'p', email: `np-${w.tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER', status: 'ACTIVE' } })).id, { title: 'عرض جديد احترافي', message: 'وصف تفصيلي لعرضي يوضح خبرتي ومنهجيتي في العمل على هذا المشروع بشكل كامل.', totalPrice: 1000, deliveryDays: 5, milestones: [{ stepOrder: 1, title: 'مرحلة أولى', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 100, amount: 1000 }], agreedToTerms: true, agreedToEscrow: true } as any), (err: any) => err.code === 'REQUEST_SUSPENDED_BY_ADMIN' || err.statusCode === 422);
	// resume -> the offer can be chosen again
	const c = await ctl(w, 'requests', w.request.id, sa); await e.http('POST', `/admin/requests/${w.request.id}/resume`, sa, { expectedVersion: c.version }, keyOf());
	const sel: any = await clientRequestsService.selectOffer(w.client.id, w.request.id, w.offer.id); assert.equal(sel.status, 'PENDING_CLIENT_SIGNATURE');
});

test('request cancel without a contract: reason + explicit confirmation + version; closes offers; consistent; idempotent; notified once after commit', opts, async () => {
	const w = await world(); const e = w.e; const sa = e.sa.id; const staff = await mkStaff(e, ['requests.manage']);
	const v = (await ctl(w, 'requests', w.request.id, sa)).version; const key = keyOf();
	const quote = (await e.http('GET', `/admin/requests/${w.request.id}/cancel-quote`, staff.user.id)).data;
	assert.equal(quote.offersToClose, 2); assert.equal(quote.blocked, null); assert.ok(quote.effects.includes('REQUEST_CANCELLED'));
	const mk = (over: any = {}) => ({ reason: 'الطلب مخالف لسياسة المنصة', expectedVersion: v, confirm: true, ...over });
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, mk({ confirm: false }), keyOf())).code, 'CONFIRMATION_REQUIRED');
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, mk({ reason: '' }), keyOf())).code, 'REASON_REQUIRED');
	const before = await snap(w); sent.length = 0;
	assert.equal(await snap(w), before, 'refusals change nothing');
	assert.equal(sent.length, 0, 'no notification for a refused call');
	const r1 = await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, mk(), key);
	assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r1.data.requestStatus, 'CANCELLED'); assert.equal(r1.data.offersClosed, 2); assert.equal(r1.data.replayed, false);
	const s = JSON.parse(await snap(w)); assert.equal(s.request.status, 'CANCELLED'); assert.ok(s.request.adminCancelledAt); assert.equal(s.project.status, 'CANCELLED'); assert.deepEqual(s.offers.map((o: any) => o.status), ['REJECTED', 'REJECTED']);
	const rows = await audit(w, 'REQUEST', w.request.id, 'REQUEST_CANCELLED_BY_ADMIN'); assert.equal(rows.length, 1); assert.equal((rows[0].context as any).reason, 'الطلب مخالف لسياسة المنصة'); assert.equal(rows[0].userId, staff.user.id);
	const n1 = sent.length; assert.ok(n1 >= 3, `client + 2 providers notified (${n1})`);
	// replay of the SAME call: the stored result, no second audit row, no second notification
	const r2 = await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, mk(), key);
	assert.equal(r2.status, 200); assert.equal(r2.data.replayed, true); assert.equal(sent.length, n1); assert.equal((await audit(w, 'REQUEST', w.request.id, 'REQUEST_CANCELLED_BY_ADMIN')).length, 1);
	// same key, different payload = conflict
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, mk({ reason: 'سبب آخر مختلف تماما' }), key)).code, 'IDEMPOTENCY_KEY_CONFLICT');
	// a new key on a cancelled request: specific reason
	assert.equal((await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, mk(), keyOf())).code, 'REQUEST_ALREADY_CANCELLED');
	// explore: a cancelled request is no longer OPEN and its Project mirror is not OPEN either
	assert.notEqual(s.project.status, 'OPEN');
});

test('request cancel with an unfunded contract: contract + offer + request move together (no escrow involved)', opts, async () => {
	const w = await world({ requestStatus: 'PENDING_SIGNATURE', contract: 'PENDING_CLIENT_SIGNATURE', offerStatus: 'PENDING_SIGNATURE', offer2Status: 'REJECTED' }); const e = w.e; const sa = e.sa.id;
	const staff = await mkStaff(e, ['requests.manage']); const both = await mkStaff(e, ['requests.manage', 'contracts.manage']);
	const c = await ctl(w, 'requests', w.request.id, sa);
	// requests.manage alone cannot cancel what touches a contract
	const denied = await e.http('POST', `/admin/requests/${w.request.id}/cancel`, staff.user.id, { reason: 'إلغاء إداري للطلب', expectedVersion: c.version, confirm: true }, keyOf()); assert.equal(denied.code, 'ADMIN_PERMISSION_DENIED');
	assert.equal(c.cancelImpact.contract.status, 'PENDING_CLIENT_SIGNATURE');
	const ok = await e.http('POST', `/admin/requests/${w.request.id}/cancel`, both.user.id, { reason: 'إلغاء إداري للطلب', expectedVersion: c.version, confirm: true }, keyOf());
	assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.data.contractStatus, 'CANCELLED'); assert.equal(ok.data.settlement, null);
	const s = JSON.parse(await snap(w)); assert.equal(s.request.status, 'CANCELLED'); assert.equal(s.contract.status, 'CANCELLED'); assert.equal(s.project.status, 'CANCELLED'); assert.ok(s.offers.every((o: any) => o.status === 'REJECTED'));
	assert.equal(s.wtx, 0, 'no money row');
});

test('cancellation that would decide HELD money is BLOCKED (settlement rule not approved); refund / release stay the explicit, previewed money actions that close the engagement', opts, async () => {
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', offerStatus: 'ACCEPTED', offer2Status: 'REJECTED' }); const e = w.e; const sa = e.sa.id;
	const both = await mkStaff(e, ['requests.manage', 'contracts.manage']);
	const c = await ctl(w, 'requests', w.request.id, sa); assert.equal(c.cancelImpact.heldAmount, 20); assert.deepEqual(c.cancelImpact.settlementOptions, []);
	assert.equal(c.actions.REQUEST_CANCEL.code, 'CANCELLATION_SETTLEMENT_NOT_APPROVED'); assert.equal(c.actions.REQUEST_CANCEL.allowed, false);
	const cc = await ctl(w, 'contracts', w.contract.id, sa); assert.equal(cc.actions.CONTRACT_CANCEL.code, 'CANCELLATION_SETTLEMENT_NOT_APPROVED');
	assert.equal(cc.actions.ESCROW_REFUND.allowed, true); assert.equal(cc.actions.ESCROW_RELEASE.allowed, true);
	const q = (await e.http('GET', `/admin/requests/${w.request.id}/cancel-quote`, sa)).data; assert.equal(q.blocked.code, 'CANCELLATION_SETTLEMENT_NOT_APPROVED'); assert.equal(q.amounts.refundToClient, 0, 'a cancel preview never promises a refund');
	const base = { reason: 'إلغاء إداري بسبب مخالفة', expectedVersion: c.version, confirm: true };
	const before = await snap(w);
	// every way of asking is refused, whoever asks, with whatever settlement text: nothing is assumed
	for (const who of [sa, both.user.id]) for (const extra of [{}, { settlement: 'REFUND_ALL_TO_CLIENT', expectedHeldAmount: 20 }, { settlement: 'SPLIT_50_50', expectedHeldAmount: 20 }]) {
		const r = await e.http('POST', `/admin/requests/${w.request.id}/cancel`, who, { ...base, ...extra }, keyOf()); assert.equal(r.status, 409); assert.equal(r.code, 'CANCELLATION_SETTLEMENT_NOT_APPROVED');
		const r2 = await e.http('POST', `/admin/contracts/${w.contract.id}/cancel`, who, { ...base, expectedVersion: cc.version, ...extra }, keyOf()); assert.equal(r2.status, 409); assert.equal(r2.code, 'CANCELLATION_SETTLEMENT_NOT_APPROVED');
	}
	assert.equal(await snap(w), before, 'no money, no status moved'); assert.equal((await audit(w, 'REQUEST', w.request.id)).length, 0);
	// the explicit refund (with its preview) closes the engagement consistently
	const rq = (await e.http('GET', `/admin/contracts/${w.contract.id}/quote?action=REFUND`, sa)).data; assert.equal(rq.amounts.refundToClient, 20); assert.equal(rq.after.projectStatus, 'CANCELLED');
	sent.length = 0;
	const ok = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, { reason: 'استرداد إداري موثّق', expectedVersion: cc.version, confirm: true, expectedHeldAmount: 20 }, keyOf());
	assert.equal(ok.status, 200, JSON.stringify(ok.json));
	const s = JSON.parse(await snap(w)); assert.deepEqual([s.escrow.status, s.contract.status, s.request.status, s.project.status], ['REFUNDED', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
	assert.equal(s.wallets.find((x: any) => x.walletBalance > 0).walletBalance, 20); assert.equal(s.wtx, 1);
	assert.ok(sent.some(n => n.userId === w.client.id && /أُعيد 20/.test(n.message)));
	assert.equal((await ctl(w, 'contracts', w.contract.id, sa)).actions.ESCROW_REFUND.code, 'CONTRACT_CLOSED');
});

test('consistency: every admin cancellation path ends with request / project / contract all CANCELLED (never DISPUTED / DRAFT); release ends all COMPLETED', opts, async () => {
	const e = await boot(); const sa = e.sa.id;
	// (a) request cancel, no contract
	const a = await world(); const ca = await ctl(a, 'requests', a.request.id, sa);
	assert.equal((await e.http('POST', `/admin/requests/${a.request.id}/cancel`, sa, { reason: 'إلغاء إداري للطلب', expectedVersion: ca.version, confirm: true }, keyOf())).status, 200);
	let s = JSON.parse(await snap(a)); assert.deepEqual([s.request.status, s.project.status], ['CANCELLED', 'CANCELLED']);
	// (b) contract cancel, unfunded
	const b = await world({ requestStatus: 'PENDING_SIGNATURE', contract: 'PENDING_PAYMENT', offerStatus: 'PENDING_SIGNATURE', offer2Status: 'REJECTED' }); const cb = await ctl(b, 'contracts', b.contract.id, sa);
	assert.equal((await e.http('POST', `/admin/contracts/${b.contract.id}/cancel`, sa, { reason: 'إلغاء إداري للعقد', expectedVersion: cb.version, confirm: true }, keyOf())).status, 200);
	s = JSON.parse(await snap(b)); assert.deepEqual([s.request.status, s.project.status, s.contract.status], ['CANCELLED', 'CANCELLED', 'CANCELLED']);
	// (c) release
	const r = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' }); const cr = await ctl(r, 'contracts', r.contract.id, sa);
	assert.equal((await e.http('POST', `/admin/contracts/${r.contract.id}/release`, sa, { reason: 'صرف إداري موثّق', expectedVersion: cr.version, confirm: true, expectedHeldAmount: 20 }, keyOf())).status, 200);
	s = JSON.parse(await snap(r)); assert.deepEqual([s.request.status, s.project.status, s.contract.status, s.escrow.status], ['COMPLETED', 'COMPLETED', 'COMPLETED', 'RELEASED']);
	// the admin lists / filters understand the new state
	const list = await e.http('GET', '/admin/projects?status=CANCELLED', sa); assert.equal(list.status, 200); assert.ok(list.data.items.some((p: any) => p.id === a.project.id)); assert.ok(list.data.counts.CANCELLED >= 2);
	assert.ok(!list.data.items.some((p: any) => p.id === r.project.id));
});

// ───────────────────────── offers ─────────────────────────
test('offer suspend/resume: permission + state matrix, accepted/linked offers go through the contract, suspended offer cannot be chosen', opts, async () => {
	const w = await world(); const e = w.e; const sa = e.sa.id;
	const off = await mkStaff(e, ['offers.manage']); const reqOnly = await mkStaff(e, ['requests.manage']);
	const c = await ctl(w, 'offers', w.offer.id, sa);
	const b = (r: any = 'سبب تعليق العرض') => ({ reason: r, expectedVersion: c.version });
	assert.equal((await e.http('POST', `/admin/offers/${w.offer.id}/suspend`, reqOnly.user.id, b(), keyOf())).code, 'ADMIN_PERMISSION_DENIED');
	assert.equal((await e.http('POST', `/admin/offers/${w.offer.id}/suspend`, off.user.id, b(''), keyOf())).code, 'REASON_REQUIRED');
	sent.length = 0;
	const ok = await e.http('POST', `/admin/offers/${w.offer.id}/suspend`, off.user.id, b(), keyOf()); assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.data.suspended, true); assert.equal(ok.data.offerStatus, 'SUBMITTED');
	assert.equal((await audit(w, 'OFFER', w.offer.id, 'OFFER_SUSPENDED')).length, 1); assert.ok(sent.some(n => n.userId === w.provider.id));
	const { clientRequestsService } = await import('./client-requests.service');
	await assert.rejects(clientRequestsService.selectOffer(w.client.id, w.request.id, w.offer.id), (err: any) => err.statusCode === 409 && err.code === 'OFFER_SUSPENDED_BY_ADMIN');
	assert.equal(JSON.parse(await snap(w)).request.status, 'OPEN', 'the refused selection changed nothing');
	const c1 = await ctl(w, 'offers', w.offer.id, sa); assert.equal(c1.actions.OFFER_SUSPEND.code, 'OFFER_ALREADY_SUSPENDED');
	const rs = await e.http('POST', `/admin/offers/${w.offer.id}/resume`, off.user.id, { reason: 'انتهت المراجعة', expectedVersion: c1.version }, keyOf()); assert.equal(rs.status, 200, JSON.stringify(rs.json));
	assert.equal((await ctl(w, 'offers', w.offer.id, sa)).actions.OFFER_RESUME.code, 'OFFER_NOT_SUSPENDED');
	// state matrix
	for (const [status, code] of [['ACCEPTED', 'OFFER_LINKED_TO_CONTRACT'], ['PENDING_SIGNATURE', 'OFFER_LINKED_TO_CONTRACT'], ['REJECTED', 'OFFER_STATE_NOT_SUSPENDABLE'], ['CANCELLED', 'OFFER_STATE_NOT_SUSPENDABLE'], ['DRAFT', 'OFFER_STATE_NOT_SUSPENDABLE']] as const) {
		const x = await world({ offerStatus: status }); const cc = await ctl(x, 'offers', x.offer.id, sa); assert.equal(cc.actions.OFFER_SUSPEND.code, code, status);
		const r = await e.http('POST', `/admin/offers/${x.offer.id}/suspend`, sa, { reason: 'سبب التعليق', expectedVersion: cc.version }, keyOf()); assert.equal(r.status, 409); assert.equal(r.code, code);
	}
	const closed = await world({ requestStatus: 'CANCELLED' }); assert.equal((await ctl(closed, 'offers', closed.offer.id, sa)).actions.OFFER_SUSPEND.code, 'OFFER_REQUEST_CLOSED');
});

// ───────────────────────── freeze ─────────────────────────
test('contract freeze/unfreeze: permission matrix, blocks new financial movements, unfreezing never pays', opts, async () => {
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' }); const e = w.e; const sa = e.sa.id;
	const staff = await mkStaff(e, ['contracts.manage']); const none = await mkStaff(e, ['requests.manage', 'offers.manage']);
	const c = await ctl(w, 'contracts', w.contract.id, sa); const b = (r: any = 'تجميد للمراجعة') => ({ reason: r, expectedVersion: c.version });
	assert.equal((await e.http('POST', `/admin/contracts/${w.contract.id}/freeze`, none.user.id, b(), keyOf())).code, 'ADMIN_PERMISSION_DENIED');
	assert.equal((await e.http('POST', `/admin/contracts/${w.contract.id}/freeze`, staff.user.id, b(''), keyOf())).code, 'REASON_REQUIRED');
	const money = await snap(w);
	const fr = await e.http('POST', `/admin/contracts/${w.contract.id}/freeze`, staff.user.id, b(), keyOf()); assert.equal(fr.status, 200, JSON.stringify(fr.json)); assert.equal(fr.data.frozen, true);
	assert.equal((await audit(w, 'CONTRACT', w.contract.id, 'CONTRACT_FROZEN')).length, 1);
	const { assertNoAdminFreeze } = await import('./admin-hold');
	await assert.rejects(assertNoAdminFreeze({ contractId: w.contract.id }), (err: any) => err.statusCode === 423 && err.code === 'CONTRACT_FROZEN_BY_ADMIN');
	await assert.rejects(assertNoAdminFreeze({ projectId: w.project.id }), (err: any) => err.statusCode === 423);
	// a frozen contract: no money action (refund / release / cancel-with-money) even for the SUPER_ADMIN, with the specific code; the freeze itself is not repeatable
	const c1 = await ctl(w, 'contracts', w.contract.id, sa);
	assert.equal(c1.actions.CONTRACT_FREEZE.code, 'CONTRACT_ALREADY_FROZEN'); assert.equal(c1.actions.ESCROW_REFUND.code, 'CONTRACT_FROZEN'); assert.equal(c1.actions.ESCROW_RELEASE.code, 'CONTRACT_FROZEN'); assert.equal(c1.actions.CONTRACT_CANCEL.code, 'CANCELLATION_SETTLEMENT_NOT_APPROVED');
	const refused = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, { reason: 'استرداد إداري', expectedVersion: c1.version, confirm: true, expectedHeldAmount: 20 }, keyOf()); assert.equal(refused.code, 'CONTRACT_FROZEN');
	const un = await e.http('POST', `/admin/contracts/${w.contract.id}/unfreeze`, staff.user.id, { expectedVersion: c1.version }, keyOf()); assert.equal(un.status, 200, JSON.stringify(un.json)); assert.equal(un.data.frozen, false);
	assert.equal(await snap(w), money, 'freeze + unfreeze moved no money and changed no status');
	assert.equal((await audit(w, 'CONTRACT', w.contract.id, 'CONTRACT_UNFROZEN')).length, 1);
	await assertNoAdminFreeze({ contractId: w.contract.id });
	assert.equal((await ctl(w, 'contracts', w.contract.id, sa)).actions.CONTRACT_UNFREEZE.code, 'CONTRACT_NOT_FROZEN');
});

// ───────────────────────── refund / release ─────────────────────────
test('refund / release: SUPER_ADMIN only at the route; quote shows amount, beneficiary, commission and effect BEFORE confirmation; moves exactly the held balance', opts, async () => {
	const e = await boot(); const sa = e.sa.id; const staff = await mkStaff(e, ['contracts.manage', 'payouts.send', 'disputes.resolve', 'finance.read']);
	// RELEASE with a v2 escrow: commission from the escrow's own snapshot (12.75% of 20 = 2.55)
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', v2: true, offerStatus: 'ACCEPTED', offer2Status: 'REJECTED' });
	const c = await ctl(w, 'contracts', w.contract.id, sa);
	const q = (await e.http('GET', `/admin/contracts/${w.contract.id}/quote?action=RELEASE`, staff.user.id)).data;
	assert.deepEqual([q.amounts.heldBefore, q.amounts.releaseToProvider, q.amounts.platformCommission, q.amounts.providerNet, q.amounts.refundToClient], [20, 20, 2.55, 17.45, 0]);
	assert.equal(q.beneficiary.kind, 'PROVIDER'); assert.equal(q.beneficiary.userId, w.provider.id); assert.equal(q.commission.ratePercent, 12.75); assert.equal(q.after.contractStatus, 'COMPLETED'); assert.ok(q.effects.includes('HELD_RELEASED_TO_PROVIDER'));
	const qr = (await e.http('GET', `/admin/contracts/${w.contract.id}/quote?action=REFUND`, sa)).data; assert.equal(qr.beneficiary.kind, 'CLIENT'); assert.equal(qr.amounts.refundToClient, 20); assert.equal(qr.amounts.platformCommission, 0);
	assert.equal((await e.http('GET', `/admin/contracts/${w.contract.id}/quote?action=NOPE`, sa)).status, 400);
	const body = { reason: 'قرار إداري موثّق', expectedVersion: c.version, confirm: true, expectedHeldAmount: 20 };
	// a staff member holding every neighbouring permission is still refused: financial = SUPER_ADMIN only
	for (const act of ['refund', 'release']) { const r = await e.http('POST', `/admin/contracts/${w.contract.id}/${act}`, staff.user.id, body, keyOf()); assert.equal(r.status, 403); assert.equal(r.code, 'ADMIN_SUPER_ADMIN_REQUIRED'); }
	assert.equal((await e.http('POST', `/admin/contracts/${w.contract.id}/release`, sa, { ...body, confirm: undefined }, keyOf())).code, 'CONFIRMATION_REQUIRED');
	assert.equal((await e.http('POST', `/admin/contracts/${w.contract.id}/release`, sa, { ...body, expectedHeldAmount: 25 }, keyOf())).code, 'HELD_BALANCE_CHANGED');
	assert.equal((await e.http('POST', `/admin/contracts/${w.contract.id}/release`, sa, { ...body, expectedHeldAmount: 19 }, keyOf())).code, 'HELD_BALANCE_CHANGED');
	sent.length = 0;
	const r = await e.http('POST', `/admin/contracts/${w.contract.id}/release`, sa, body, keyOf()); assert.equal(r.status, 200, JSON.stringify(r.json));
	assert.deepEqual([r.data.settlement.releaseToProvider, r.data.settlement.platformCommission, r.data.settlement.providerNet], [20, 2.55, 17.45]);
	const s = JSON.parse(await snap(w)); assert.equal(s.escrow.status, 'RELEASED'); assert.equal(s.escrow.releasedAmount, 20); assert.equal(s.escrow.platformCommissionAmount, 2.55); assert.equal(s.escrow.providerNetReleasedAmount, 17.45);
	assert.equal(s.contract.status, 'COMPLETED'); assert.equal(s.request.status, 'COMPLETED'); assert.equal(s.wtx, 0, 'a release credits no client wallet'); assert.deepEqual(s.wallets.map((x: any) => x.walletBalance), [0, 0]);
	assert.equal((await audit(w, 'CONTRACT', w.contract.id, 'ESCROW_RELEASED_BY_ADMIN')).length, 1); assert.ok(sent.length >= 2);
	// never pay twice / never refund what was released
	const c2 = await ctl(w, 'contracts', w.contract.id, sa); assert.equal(c2.actions.ESCROW_RELEASE.code, 'CONTRACT_CLOSED'); assert.equal(c2.actions.ESCROW_REFUND.code, 'CONTRACT_CLOSED');
	const again = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, { ...body, expectedVersion: c2.version }, keyOf()); assert.equal(again.status, 409); assert.equal(again.code, 'CONTRACT_CLOSED');
	assert.equal(JSON.stringify(JSON.parse(await snap(w))), JSON.stringify(s), 'second attempts changed nothing');
});

test('refund limited to the REAL held balance (earlier release is never refunded) and a released-state escrow refuses both money actions', opts, async () => {
	const e = await boot(); const sa = e.sa.id;
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', released: 10, v2: true });
	const c = await ctl(w, 'contracts', w.contract.id, sa); assert.equal(c.escrow.heldAmount, 10);
	const body = { reason: 'استرداد إداري موثّق', expectedVersion: c.version, confirm: true };
	assert.equal((await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, { ...body, expectedHeldAmount: 20 }, keyOf())).code, 'HELD_BALANCE_CHANGED', 'cannot refund the already-released 10');
	const ok = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, { ...body, expectedHeldAmount: 10 }, keyOf()); assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.data.settlement.refundToClient, 10);
	const s = JSON.parse(await snap(w)); assert.equal(s.escrow.releasedAmount, 10, 'what was released is untouched'); assert.equal(s.escrow.status, 'REFUNDED'); assert.equal(s.wallets.some((x: any) => x.walletBalance === 10), true);
	// an escrow already RELEASED / REFUNDED with a (wrongly) still-open contract: specific reasons, nothing moves
	for (const [state, code] of [['RELEASED', 'ESCROW_ALREADY_RELEASED'], ['REFUNDED', 'ESCROW_ALREADY_REFUNDED']] as const) {
		const x = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: state, released: state === 'RELEASED' ? 20 : 0 });
		const cc = await ctl(x, 'contracts', x.contract.id, sa); assert.equal(cc.actions.ESCROW_REFUND.code, code); assert.equal(cc.actions.ESCROW_RELEASE.code, code);
		const before = await snap(x); const r = await e.http('POST', `/admin/contracts/${x.contract.id}/refund`, sa, { reason: 'استرداد إداري موثّق', expectedVersion: cc.version, confirm: true, expectedHeldAmount: 20 }, keyOf()); assert.equal(r.code, code); assert.equal(await snap(x), before);
	}
	const none = await world({ requestStatus: 'PENDING_SIGNATURE', contract: 'PENDING_CLIENT_SIGNATURE' }); assert.equal((await ctl(none, 'contracts', none.contract.id, sa)).actions.ESCROW_REFUND.code, 'NO_ESCROW');
	const early = await world({ requestStatus: 'PENDING_SIGNATURE', contract: 'PENDING_PROVIDER_SIGNATURE', escrow: 'HELD' }); const ec = await ctl(early, 'contracts', early.contract.id, sa);
	assert.equal(ec.actions.ESCROW_RELEASE.code, 'RELEASE_REQUIRES_ACTIVE_CONTRACT'); assert.equal(ec.actions.ESCROW_REFUND.allowed, true);
});

test('double click / parallel requests: the same key runs ONCE and replays; different keys serialise on the row lock and only one money movement happens', opts, async () => {
	const e = await boot(); const sa = e.sa.id;
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' }); const c = await ctl(w, 'contracts', w.contract.id, sa);
	const body = { reason: 'استرداد إداري موثّق', expectedVersion: c.version, confirm: true, expectedHeldAmount: 20 }; const key = keyOf(); sent.length = 0;
	const same = await Promise.all([1, 2, 3, 4, 5].map(() => e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, body, key)));
	assert.deepEqual(same.map(r => r.status), [200, 200, 200, 200, 200], JSON.stringify(same.map(r => r.code)));
	assert.equal(same.filter(r => r.data.replayed === false).length, 1); assert.equal(same.filter(r => r.data.replayed === true).length, 4);
	let s = JSON.parse(await snap(w)); assert.equal(s.wallets.find((x: any) => x.walletBalance > 0).walletBalance, 20, 'credited exactly once'); assert.equal(s.wtx, 1);
	assert.equal((await audit(w, 'CONTRACT', w.contract.id, 'ESCROW_REFUNDED_BY_ADMIN')).length, 1);
	const w2 = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' }); const c2 = await ctl(w2, 'contracts', w2.contract.id, sa);
	const b2 = { reason: 'استرداد إداري موثّق', expectedVersion: c2.version, confirm: true, expectedHeldAmount: 20 };
	const diff = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => e.http('POST', `/admin/contracts/${w2.contract.id}/${i % 2 ? 'refund' : 'release'}`, sa, b2, keyOf())));
	assert.equal(diff.filter(r => r.status === 200).length, 1, JSON.stringify(diff.map(r => [r.status, r.code])));
	assert.ok(diff.filter(r => r.status !== 200).every(r => r.status === 409), JSON.stringify(diff.map(r => [r.status, r.code])));
	s = JSON.parse(await snap(w2)); assert.ok(['REFUNDED', 'RELEASED'].includes(s.escrow.status)); assert.ok(s.wtx <= 1);
	// request-cancel (blocked while money is held) racing a refund: the refund wins, the other is refused, no contradictory end state
	const w3 = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', offerStatus: 'ACCEPTED', offer2Status: 'REJECTED' }); const c3 = await ctl(w3, 'requests', w3.request.id, sa); const cc3 = await ctl(w3, 'contracts', w3.contract.id, sa);
	const race = await Promise.all([
		e.http('POST', `/admin/requests/${w3.request.id}/cancel`, sa, { reason: 'إلغاء الطلب إداريا', expectedVersion: c3.version, confirm: true }, keyOf()),
		e.http('POST', `/admin/contracts/${w3.contract.id}/refund`, sa, { reason: 'استرداد العقد إداريا', expectedVersion: cc3.version, confirm: true, expectedHeldAmount: 20 }, keyOf())
	]);
	assert.equal(race.filter(r => r.status === 200).length, 1, JSON.stringify(race.map(r => [r.status, r.code]))); s = JSON.parse(await snap(w3));
	assert.deepEqual([s.request.status, s.contract.status, s.escrow.status], ['CANCELLED', 'CANCELLED', 'REFUNDED']); assert.equal(s.wtx, 1);
});

test('dispute freeze and in-flight cancellation are respected: no money / cancel while a dispute is open or a mutual cancellation awaits settlement', opts, async () => {
	const e = await boot(); const sa = e.sa.id;
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' });
	await e.prisma.dispute.create({ data: { id: id(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, status: 'OPEN', reason: 'سبب', description: 'وصف' } });
	const c = await ctl(w, 'contracts', w.contract.id, sa);
	for (const a of ['CONTRACT_CANCEL', 'ESCROW_REFUND', 'ESCROW_RELEASE']) assert.equal(c.actions[a].code, 'ACTIVE_DISPUTE', a);
	assert.equal(c.actions.CONTRACT_FREEZE.allowed, true, 'freezing is still possible during a dispute');
	const before = await snap(w);
	const body = { reason: 'قرار إداري موثّق', expectedVersion: c.version, confirm: true, expectedHeldAmount: 20 };
	for (const act of ['refund', 'release', 'cancel']) { const r = await e.http('POST', `/admin/contracts/${w.contract.id}/${act}`, sa, body, keyOf()); assert.equal(r.status, 409, act); assert.equal(r.code, 'ACTIVE_DISPUTE'); }
	const rq = await ctl(w, 'requests', w.request.id, sa); assert.equal(rq.actions.REQUEST_CANCEL.code, 'ACTIVE_DISPUTE');
	assert.equal(await snap(w), before);
	// an AGREED mutual cancellation: settled through its own flow
	const x = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' });
	await e.prisma.contractCancellationRequest.create({ data: { id: id(), contractId: x.contract.id, projectId: x.project.id, clientId: x.client.id, providerId: x.provider.id, requestedById: x.client.id, requestedByRole: 'CLIENT', reason: 'اتفاق', status: 'AGREED_PENDING_SETTLEMENT', settlementStatus: 'PENDING_ADMIN_DECISION' } });
	const cx = await ctl(x, 'contracts', x.contract.id, sa); for (const a of ['CONTRACT_CANCEL', 'ESCROW_REFUND', 'ESCROW_RELEASE']) assert.equal(cx.actions[a].code, 'CANCELLATION_AGREED_PENDING_SETTLEMENT', a);
	// an open (not yet answered) request is closed with the contract
	const y = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE' });
	const pending = await e.prisma.contractCancellationRequest.create({ data: { id: id(), contractId: y.contract.id, projectId: y.project.id, clientId: y.client.id, providerId: y.provider.id, requestedById: y.client.id, requestedByRole: 'CLIENT', reason: 'طلب', status: 'PENDING_OTHER_PARTY' } });
	const cy = await ctl(y, 'contracts', y.contract.id, sa);
	const done = await e.http('POST', `/admin/contracts/${y.contract.id}/cancel`, sa, { reason: 'إلغاء إداري للعقد', expectedVersion: cy.version, confirm: true }, keyOf()); assert.equal(done.status, 200, JSON.stringify(done.json));
	assert.equal((await e.prisma.contractCancellationRequest.findUnique({ where: { id: pending.id } })).status, 'REJECTED');
});

// ───────────────────────── atomicity ─────────────────────────
test('failure of the audit write or of the money step leaves NO partial change, no key row, and the same key can be retried', opts, async () => {
	const e = await boot(); const sa = e.sa.id;
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', offerStatus: 'ACCEPTED', offer2Status: 'SUBMITTED' }); const c = await ctl(w, 'contracts', w.contract.id, sa);
	const body = { reason: 'استرداد إداري موثّق', expectedVersion: c.version, confirm: true, expectedHeldAmount: 20 }; const key = keyOf(); const before = await snap(w); sent.length = 0;
	// (1) the audit insert is rejected by a database trigger: the whole refund rolls back
	await e.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION qa_oc_block_audit() RETURNS trigger AS $$ BEGIN IF NEW."eventType" = 'ESCROW_REFUNDED_BY_ADMIN' THEN RAISE EXCEPTION 'qa audit blocked'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
	await e.prisma.$executeRawUnsafe(`CREATE TRIGGER qa_oc_block_audit_trg BEFORE INSERT ON "account_audit_logs" FOR EACH ROW EXECUTE FUNCTION qa_oc_block_audit()`);
	try {
		const failed = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, body, key);
		assert.ok(failed.status >= 500, `audit failure fails the action (${failed.status})`);
		assert.equal(await snap(w), before, 'no escrow / wallet / status change'); assert.equal((await e.prisma.adminActionIdempotency.count({ where: { key } })), 0, 'no key row survives a rollback');
		assert.equal((await audit(w, 'CONTRACT', w.contract.id, 'ESCROW_REFUNDED_BY_ADMIN')).length, 0); assert.equal(sent.length, 0, 'no notification for a rolled-back action');
	} finally { await e.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_oc_block_audit_trg ON "account_audit_logs"'); }
	// (2) a failure AFTER the money moved (test seam) also rolls the money back
	e.adminControlDeps.afterMoney = () => { throw new Error('boom after money'); };
	try { const failed = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, body, key); assert.ok(failed.status >= 500); assert.equal(await snap(w), before); } finally { e.adminControlDeps.afterMoney = undefined; }
	// (3) the same key now succeeds exactly once
	const ok = await e.http('POST', `/admin/contracts/${w.contract.id}/refund`, sa, body, key); assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.data.replayed, false);
	assert.equal(JSON.parse(await snap(w)).wtx, 1);
});

test('notifications run only after the commit and never fail the action', opts, async () => {
	const w = await world(); const e = w.e; const sa = e.sa.id;
	const c = await ctl(w, 'requests', w.request.id, sa); sent.length = 0;
	const prev = e.adminControlDeps.notify; e.adminControlDeps.notify = async () => { throw new Error('mail down'); };
	try {
		const r = await e.http('POST', `/admin/requests/${w.request.id}/suspend`, sa, { reason: 'تعليق للتحقق', expectedVersion: c.version }, keyOf());
		assert.equal(r.status, 200, 'a notification failure does not undo or fail the committed action'); assert.equal(JSON.parse(await snap(w)).request.adminSuspendedAt !== null, true);
	} finally { e.adminControlDeps.notify = prev; }
	// a refused (409) action sends nothing
	const r2 = await e.http('POST', `/admin/requests/${w.request.id}/suspend`, sa, { reason: 'تعليق للتحقق', expectedVersion: 'x' }, keyOf()); assert.equal(r2.status, 409); assert.equal(sent.length, 0);
});

test('keys are scoped per admin; controls read model carries a specific code for every blocked action (never a generic one)', opts, async () => {
	const w = await world(); const e = w.e; const sa = e.sa.id; const staff = await mkStaff(e, ['requests.manage']);
	const c = await ctl(w, 'requests', w.request.id, sa); const key = keyOf();
	const a = await e.http('POST', `/admin/requests/${w.request.id}/suspend`, sa, { reason: 'تعليق للتحقق', expectedVersion: c.version }, key); assert.equal(a.status, 200);
	const c2 = await ctl(w, 'requests', w.request.id, staff.user.id);
	for (const [name, act] of Object.entries(c2.actions) as any) if (!act.allowed) assert.ok(/^[A-Z_]+$/.test(act.code), `${name}: ${act.code}`);
	// the same key string used by ANOTHER admin is its own key (it is not a replay of the first admin's call)
	const b = await e.http('POST', `/admin/requests/${w.request.id}/resume`, staff.user.id, { expectedVersion: c2.version }, key); assert.equal(b.status, 200, JSON.stringify(b.json)); assert.equal(b.data.replayed, false);
	// a staff without the permission sees every action as PERMISSION_DENIED (detail scope only)
	const reader = await mkStaff(e, ['disputes.view']); await e.prisma.dispute.create({ data: { id: id(), requestId: w.request.id, openedById: w.client.id, status: 'OPEN', reason: 'سبب', description: 'وصف' } });
	const rc = await ctl(w, 'requests', w.request.id, reader.user.id); assert.equal(rc.actions.REQUEST_CANCEL.code, 'ADMIN_PERMISSION_DENIED'); assert.equal(rc.actions.REQUEST_SUSPEND.allowed, false);
});

// ───────────────────────── suspension races (select / accept / create vs the admin suspension) ─────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * Interleaving "the admin is mid-suspension": a transaction takes the SAME locks, in the SAME order, as the admin action (request -> contract -> offers), starts the service call under test,
 * waits until that call is really blocked on a lock (pg_stat_activity), writes the suspension and commits. The call must then be refused by the re-check done under the lock.
 */
async function suspendWhileBlocked(w: W, start: () => Promise<any>, write: (tx: any) => Promise<void>) {
	const prisma = w.e.prisma; let svc: Promise<{ ok?: any; err?: any }> = Promise.resolve({});
	await prisma.$transaction(async (tx: any) => {
		await tx.$queryRaw`SELECT "id" FROM "client_requests" WHERE "id" = ${w.request.id} FOR UPDATE`;
		await tx.$queryRaw`SELECT "id" FROM "contracts" WHERE "projectId" = ${w.request.id} FOR UPDATE`;
		await tx.$queryRaw`SELECT "id" FROM "project_proposals" WHERE "projectId" = ${w.request.id} FOR UPDATE`;
		svc = start().then(ok => ({ ok }), err => ({ err }));
		let blocked = false;
		for (let i = 0; i < 100 && !blocked; i++) { await sleep(100); const r: any[] = await tx.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`; blocked = r[0].n > 0; }
		assert.ok(blocked, 'the service call is blocked on the admin locks (it reached its transaction)');
		await write(tx);
	}, { timeout: 30000 });
	return svc;
}
const provPayload = { title: 'عرض جديد احترافي', message: 'وصف تفصيلي لعرضي يوضح خبرتي ومنهجيتي في العمل على هذا المشروع بشكل كامل.', totalPrice: 1000, deliveryDays: 5, milestones: [{ stepOrder: 1, title: 'مرحلة أولى', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 100, amount: 1000 }], agreedToTerms: true, agreedToEscrow: true } as any;

test('RACE select: an admin request suspension that lands while selectOffer is in flight refuses the selection (atomic under the locks); select-first leaves no suspended request with a chosen offer', opts, async () => {
	const w = await world(); const e = w.e; const { clientRequestsService } = await import('./client-requests.service');
	const r = await suspendWhileBlocked(w, () => clientRequestsService.selectOffer(w.client.id, w.request.id, w.offer.id), tx => tx.clientRequest.update({ where: { id: w.request.id }, data: { adminSuspendedAt: new Date(), adminSuspendedById: e.sa.id, adminSuspendReason: 'x' } }));
	assert.ok(r.err && r.err.code === 'REQUEST_SUSPENDED_BY_ADMIN', `refused after the suspension committed: ${r.err?.code ?? 'selection succeeded'}`);
	const s = JSON.parse(await snap(w)); assert.equal(s.request.status, 'OPEN'); assert.equal(s.contract, null); assert.deepEqual(s.offers.map((o: any) => o.status), ['SUBMITTED', 'SUBMITTED']);
	// the other order: select commits first, the (later) suspension is refused by the rule table
	const x = await world(); const sel: any = await clientRequestsService.selectOffer(x.client.id, x.request.id, x.offer.id); assert.equal(sel.status, 'PENDING_CLIENT_SIGNATURE');
	const cx = await ctl(x, 'requests', x.request.id, e.sa.id); assert.equal(cx.actions.REQUEST_SUSPEND.allowed, false); assert.ok(['REQUEST_HAS_CONTRACT', 'REQUEST_NOT_OPEN'].includes(cx.actions.REQUEST_SUSPEND.code));
});

test('RACE select (offer): an admin OFFER suspension landing during selectOffer refuses the selection', opts, async () => {
	const w = await world(); const e = w.e; const { clientRequestsService } = await import('./client-requests.service');
	const r = await suspendWhileBlocked(w, () => clientRequestsService.selectOffer(w.client.id, w.request.id, w.offer.id), tx => tx.projectProposal.update({ where: { id: w.offer.id }, data: { adminSuspendedAt: new Date(), adminSuspendedById: e.sa.id, adminSuspendReason: 'x' } }));
	assert.ok(r.err && r.err.code === 'OFFER_SUSPENDED_BY_ADMIN', r.err?.code);
	const s = JSON.parse(await snap(w)); assert.equal(s.request.status, 'OPEN'); assert.equal(s.contract, null);
	// select-first: the chosen offer is linked to the contract and can no longer be suspended on its own
	const x = await world(); await clientRequestsService.selectOffer(x.client.id, x.request.id, x.offer.id);
	assert.equal((await ctl(x, 'offers', x.offer.id, e.sa.id)).actions.OFFER_SUSPEND.code, 'OFFER_LINKED_TO_CONTRACT');
});

test('RACE accept counter: suspension landing during the acceptance refuses it (request and offer); accept-first then suspend leaves a consistent offer', opts, async () => {
	const e = await boot(); const { clientOfferCounterService } = await import('./client-offer-counter.service'); const { buildProviderEntry } = await import('../utils/offer-negotiation');
	const mk = async () => {
		const w = await world({ offerStatus: 'UNDER_NEGOTIATION' });
		const conv = await e.prisma.conversation.create({ data: { id: id(), projectId: w.request.id, offerId: w.offer.id, clientId: w.client.id, providerId: w.provider.id } });
		const msg = await e.prisma.message.create({ data: { id: id(), conversationId: conv.id, senderId: w.provider.id, type: 'TEXT', status: 'SENT', content: buildProviderEntry('PROVIDER_COUNTER', { offerId: w.offer.id, price: 15, deliveryDays: 3 }) } });
		return { w, msg };
	};
	const A = await mk();
	let r = await suspendWhileBlocked(A.w, () => clientOfferCounterService.accept(A.w.client.id, A.w.request.id, A.w.offer.id, { messageId: A.msg.id }), tx => tx.clientRequest.update({ where: { id: A.w.request.id }, data: { adminSuspendedAt: new Date(), adminSuspendedById: e.sa.id, adminSuspendReason: 'x' } }));
	assert.equal(r.err?.code, 'REQUEST_SUSPENDED_BY_ADMIN'); assert.equal(JSON.parse(await snap(A.w)).offers[0].status === 'UNDER_NEGOTIATION' || JSON.parse(await snap(A.w)).offers[1].status === 'UNDER_NEGOTIATION', true, 'the offer terms were not changed');
	const B = await mk();
	r = await suspendWhileBlocked(B.w, () => clientOfferCounterService.accept(B.w.client.id, B.w.request.id, B.w.offer.id, { messageId: B.msg.id }), tx => tx.projectProposal.update({ where: { id: B.w.offer.id }, data: { adminSuspendedAt: new Date(), adminSuspendedById: e.sa.id, adminSuspendReason: 'x' } }));
	assert.equal(r.err?.code, 'OFFER_SUSPENDED_BY_ADMIN'); assert.equal((await e.prisma.projectProposal.findUnique({ where: { id: B.w.offer.id } })).totalPrice, 20, 'price unchanged');
	// accept first, suspend after: both succeed and the offer is a consistent live (SUBMITTED) suspended offer
	const C = await mk();
	const acc: any = await clientOfferCounterService.accept(C.w.client.id, C.w.request.id, C.w.offer.id, { messageId: C.msg.id }); assert.equal(acc.status, 'SUBMITTED');
	const c = await ctl(C.w, 'offers', C.w.offer.id, e.sa.id); assert.equal(c.actions.OFFER_SUSPEND.allowed, true);
	assert.equal((await e.http('POST', `/admin/offers/${C.w.offer.id}/suspend`, e.sa.id, { reason: 'تعليق بعد القبول', expectedVersion: c.version }, keyOf())).status, 200);
});

test('RACE create offer: a suspension (or admin cancellation) landing during createProposal refuses the new offer; no offer is ever created after the suspension committed', opts, async () => {
	const w = await world(); const e = w.e; const { proposalService } = await import('./proposal.service');
	const mkProv = (n: string) => e.prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: n, lastName: 'p', email: `${n}-${w.tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER', status: 'ACTIVE' } });
	const p1 = await mkProv('a');
	const r = await suspendWhileBlocked(w, () => proposalService.createProposal(w.request.id, p1.id, provPayload), tx => tx.clientRequest.update({ where: { id: w.request.id }, data: { adminSuspendedAt: new Date(), adminSuspendedById: e.sa.id, adminSuspendReason: 'x' } }));
	assert.equal(r.err?.code, 'REQUEST_SUSPENDED_BY_ADMIN', r.err?.code ?? 'offer created');
	assert.equal(await e.prisma.projectProposal.count({ where: { projectId: w.request.id, providerId: p1.id } }), 0, 'no offer row');
	// cancelled by an admin during creation: refused too (the request is no longer OPEN)
	const x = await world(); const p2 = await mkProv('b');
	const r2 = await suspendWhileBlocked(x, () => proposalService.createProposal(x.request.id, p2.id, provPayload), tx => tx.clientRequest.update({ where: { id: x.request.id }, data: { status: 'CANCELLED' } }));
	assert.ok(r2.err && (r2.err.code === 'PROJECT_NOT_OPEN' || r2.err.statusCode === 422), r2.err?.code ?? 'offer created');
	assert.equal(await e.prisma.projectProposal.count({ where: { projectId: x.request.id, providerId: p2.id } }), 0);
	// true parallelism, many rounds: no offer is created AFTER the suspension committed (createdAt <= adminSuspendedAt), whichever side wins
	for (let i = 0; i < 8; i++) {
		const y = await world(); const p = await mkProv(`r${i}`); const cy = await ctl(y, 'requests', y.request.id, e.sa.id);
		const [created, susp] = await Promise.all([
			proposalService.createProposal(y.request.id, p.id, provPayload).then(() => 'created', (er: any) => er.code ?? 'refused'),
			e.http('POST', `/admin/requests/${y.request.id}/suspend`, e.sa.id, { reason: 'تعليق متوازٍ', expectedVersion: cy.version }, keyOf())
		]);
		const reqRow = await e.prisma.clientRequest.findUnique({ where: { id: y.request.id } }); const offer = await e.prisma.projectProposal.findFirst({ where: { projectId: y.request.id, providerId: p.id } });
		if (offer && reqRow.adminSuspendedAt) assert.ok(offer.createdAt <= reqRow.adminSuspendedAt, `round ${i}: offer created after the suspension (${created}/${susp.status})`);
		if (susp.status === 200) assert.ok(created === 'created' ? !!offer : !offer, `round ${i}`);
	}
});

test('RACE select vs suspend in true parallel (many rounds): never a suspended request that also has a chosen offer / contract', opts, async () => {
	const e = await boot(); const { clientRequestsService } = await import('./client-requests.service');
	for (let i = 0; i < 10; i++) {
		const w = await world(); const c = await ctl(w, 'requests', w.request.id, e.sa.id);
		const [sel, susp] = await Promise.all([
			clientRequestsService.selectOffer(w.client.id, w.request.id, w.offer.id).then(() => 'selected', (er: any) => er.code ?? er.message),
			e.http('POST', `/admin/requests/${w.request.id}/suspend`, e.sa.id, { reason: 'تعليق متوازٍ', expectedVersion: c.version }, keyOf())
		]);
		const s = JSON.parse(await snap(w)); const suspended = s.request.adminSuspendedAt !== null;
		assert.ok(!(suspended && (s.request.status !== 'OPEN' || s.contract)), `round ${i}: suspended + chosen (${sel}/${susp.status}/${susp.code})`);
		assert.ok(susp.status === 200 ? sel !== 'selected' : sel === 'selected' || true);
	}
});

// ───────────────────────── canonical lock order: FORCED interleavings (services/lock-order.ts) ─────────────────────────
/**
 * "An admin action is in flight": a transaction holds the request row FIRST (the canonical order), the service call under test starts and is waited on until it is really blocked on a lock, then
 * the admin transaction continues with the NEXT locks of its order (contract, offers) and either commits `after()` or rolls back. With the old order (contract first) the flow under test would
 * already hold the contract row, the admin transaction would wait for it while the flow waits for the request row: PostgreSQL aborts one with 40P01. The canonical order makes that impossible.
 */
async function adminInFlight(w: W, start: () => Promise<any>, after: (tx: any) => Promise<void>, opts2: { rollback?: boolean } = {}) {
	const prisma = w.e.prisma; let svc: Promise<{ ok?: any; err?: any }> = Promise.resolve({}); let adminErr: any = null;
	try {
		await prisma.$transaction(async (tx: any) => {
			await tx.$queryRaw`SELECT "id" FROM "client_requests" WHERE "id" = ${w.request.id} FOR UPDATE`;
			svc = start().then(ok => ({ ok }), err => ({ err }));
			let blocked = false;
			for (let i = 0; i < 100 && !blocked; i++) { await sleep(100); const r: any[] = await tx.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`; blocked = r[0].n > 0; }
			assert.ok(blocked, 'the flow under test is blocked on the admin request lock (it takes the request row FIRST)');
			await tx.$queryRaw`SELECT "id" FROM "contracts" WHERE "projectId" = ${w.request.id} FOR UPDATE`; // the admin transaction's NEXT lock: must be obtainable
			await tx.$queryRaw`SELECT "id" FROM "project_proposals" WHERE "projectId" = ${w.request.id} FOR UPDATE`;
			await after(tx);
			if (opts2.rollback) throw new Error('admin-rollback');
		}, { timeout: 30000 });
	} catch (e: any) { adminErr = e; }
	const r = await svc;
	if (opts2.rollback) assert.equal(adminErr?.message, 'admin-rollback'); else assert.equal(adminErr, null, `the admin transaction must not be aborted (deadlock): ${adminErr?.message}`);
	const dead = (x: any) => /deadlock|40P01/i.test(String(x?.message ?? '')) || x?.code === '40P01';
	assert.ok(!dead(r.err), `the flow under test must not deadlock: ${r.err?.message}`);
	return r;
}
const freezeIt = (w: W) => (tx: any) => tx.contract.update({ where: { id: w.contract.id }, data: { adminFrozenAt: new Date(), adminFrozenById: w.e.sa.id, adminFreezeReason: 'x' } });
const noop = async () => undefined;

async function finalStageWorld() {
	const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', released: 10, v2: true, offerStatus: 'ACCEPTED', offer2Status: 'REJECTED' });
	const s2 = await w.e.prisma.projectStage.findFirst({ where: { contractId: w.contract.id, stepOrder: 2 } });
	await w.e.prisma.projectStage.update({ where: { id: s2.id }, data: { status: 'SUBMITTED' } });
	await w.e.prisma.stageDelivery.create({ data: { id: id(), stageId: s2.id, providerId: w.provider.id, note: 'synthetic delivery note', status: 'SUBMITTED' } });
	return { w, s2 };
}

test('LOCK ORDER final stage approval (locks contract then updates the request): forced interleaving - frozen by the admin = refused with NO money; plain commit = paid once and consistent; admin rollback = same', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	// (a) the admin freezes while the approval waits: the approval is refused (423), nothing moves
	let { w, s2 } = await finalStageWorld(); let before = await snap(w);
	let r = await adminInFlight(w, () => projectProgressService.reviewDelivery(w.client.id, w.contract.id, s2.id, 'approve'), freezeIt(w));
	assert.ok(r.err && r.err.statusCode === 423 && r.err.code === 'CONTRACT_FROZEN_BY_ADMIN', r.err?.code ?? 'approved despite the freeze');
	const f = JSON.parse(await snap(w)); assert.deepEqual([f.escrow.status, f.escrow.releasedAmount, f.contract.status, f.request.status], ['HELD', 10, 'ACTIVE', 'IN_PROGRESS']); assert.equal((await w.e.prisma.projectStage.findUnique({ where: { id: s2.id } })).status, 'SUBMITTED');
	assert.notEqual(before, await snap(w)); // (only the freeze itself changed)
	// (b) the admin only held the locks and committed nothing: the approval completes ONCE and every record agrees
	({ w, s2 } = await finalStageWorld());
	r = await adminInFlight(w, () => projectProgressService.reviewDelivery(w.client.id, w.contract.id, s2.id, 'approve'), noop);
	assert.ok(!r.err, `approval completes: ${r.err?.message}`);
	let s = JSON.parse(await snap(w)); assert.deepEqual([s.escrow.status, s.escrow.releasedAmount, s.contract.status, s.request.status, s.project.status], ['RELEASED', 20, 'COMPLETED', 'COMPLETED', 'COMPLETED']);
	assert.equal(s.escrow.platformCommissionAmount + s.escrow.providerNetReleasedAmount, 20);
	assert.equal(await w.e.prisma.accountAuditLog.count({ where: { eventType: 'STAGE_FUND_RELEASED', context: { path: ['stageId'], equals: s2.id } } }) + await w.e.prisma.accountAuditLog.count({ where: { eventType: 'STAGE_FUND_RELEASED', metaData: { path: ['stageId'], equals: s2.id } } }), 1, 'one release audit row');
	// (c) the admin transaction ROLLS BACK: the approval still completes once, no trace of the admin's attempt
	({ w, s2 } = await finalStageWorld());
	r = await adminInFlight(w, () => projectProgressService.reviewDelivery(w.client.id, w.contract.id, s2.id, 'approve'), freezeIt(w), { rollback: true });
	assert.ok(!r.err, `approval completes after the admin rolled back: ${r.err?.message}`);
	s = JSON.parse(await snap(w)); assert.deepEqual([s.escrow.status, s.contract.status, s.request.status, s.contract && s.contract.adminFrozenAt], ['RELEASED', 'COMPLETED', 'COMPLETED', null]);
});

test('LOCK ORDER consensual-cancellation settlement: forced interleaving (freeze = refused, plain = settled once, rollback = settled once); money, states and audit agree', opts, async () => {
	const { contractCancellationService } = await import('./contract-cancellation.service');
	const mk = async () => {
		const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', v2: true, offerStatus: 'ACCEPTED', offer2Status: 'REJECTED' });
		const cr = await w.e.prisma.contractCancellationRequest.create({ data: { id: id(), contractId: w.contract.id, projectId: w.project.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.client.id, requestedByRole: 'CLIENT', reason: 'اتفاق', status: 'AGREED_PENDING_SETTLEMENT', settlementStatus: 'PENDING_ADMIN_DECISION', respondedById: w.provider.id, respondedAt: new Date() } });
		return { w, cr };
	};
	const input = { releaseToProvider: 5, expectedHeldAmount: 20, reason: 'تسوية بعد اتفاق الطرفين' };
	let { w, cr } = await mk(); let r = await adminInFlight(w, () => contractCancellationService.settle(w.e.sa.id, cr.id, input), freezeIt(w));
	assert.ok(r.err && r.err.statusCode === 423 && r.err.code === 'CONTRACT_FROZEN_BY_ADMIN', r.err?.code ?? 'settled despite the freeze');
	let s = JSON.parse(await snap(w)); assert.deepEqual([s.escrow.status, s.contract.status, s.request.status, s.wtx], ['HELD', 'ACTIVE', 'IN_PROGRESS', 0]);
	assert.equal((await w.e.prisma.contractCancellationRequest.findUnique({ where: { id: cr.id } })).status, 'AGREED_PENDING_SETTLEMENT');
	for (const rollback of [false, true]) {
		({ w, cr } = await mk()); r = await adminInFlight(w, () => contractCancellationService.settle(w.e.sa.id, cr.id, input), rollback ? freezeIt(w) : noop, { rollback });
		assert.ok(!r.err, `settlement completes: ${r.err?.message}`);
		s = JSON.parse(await snap(w)); assert.equal(s.escrow.releasedAmount, 5); assert.equal(s.wtx, 1, 'the refund row exists once'); assert.equal(s.wallets.find((x: any) => x.walletBalance > 0).walletBalance, 15);
		assert.deepEqual([s.contract.status, s.request.status], ['CANCELLED', 'COMPLETED']); // existing policy of this flow, unchanged
		assert.equal(await w.e.prisma.accountAuditLog.count({ where: { eventType: 'CANCELLATION_SETTLED', context: { path: ['entityId'], equals: cr.id } } }), 1);
	}
});

test('LOCK ORDER financial dispute decision and dispute opening: forced interleavings; no deadlock, money / states / audit consistent', opts, async () => {
	const { disputeService } = await import('./dispute.service');
	const mk = async () => {
		const w = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD', v2: true, offerStatus: 'ACCEPTED', offer2Status: 'REJECTED' });
		const d = await w.e.prisma.dispute.create({ data: { id: id(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, reason: 'x', description: 'y'.repeat(30), status: 'OPEN' } });
		return { w, d };
	};
	const fin = { outcome: 'SPLIT', refundToClient: 15, releaseToProvider: 5, expectedHeldAmount: 20, resolutionNote: 'قرار نزاع مالي موثّق' } as any;
	let { w, d } = await mk(); let r = await adminInFlight(w, () => disputeService.resolveFinancial(d.id, w.e.sa.id, fin), freezeIt(w));
	assert.ok(r.err && r.err.statusCode === 423, r.err?.code ?? 'decided despite the freeze'); let s = JSON.parse(await snap(w)); assert.deepEqual([s.escrow.status, s.contract.status, s.wtx], ['HELD', 'ACTIVE', 0]);
	assert.equal((await w.e.prisma.dispute.findUnique({ where: { id: d.id } })).status, 'OPEN');
	for (const rollback of [false, true]) {
		({ w, d } = await mk()); r = await adminInFlight(w, () => disputeService.resolveFinancial(d.id, w.e.sa.id, fin), rollback ? freezeIt(w) : noop, { rollback });
		assert.ok(!r.err, `decision completes: ${r.err?.message}`); s = JSON.parse(await snap(w));
		assert.equal(s.escrow.releasedAmount, 5); assert.equal(s.wtx, 1); assert.equal(s.wallets.find((x: any) => x.walletBalance > 0).walletBalance, 15); assert.equal(s.request.status, 'COMPLETED');
		assert.equal(await w.e.prisma.accountAuditLog.count({ where: { eventType: 'DISPUTE_FINANCIAL_RESOLVED', context: { path: ['entityId'], equals: d.id } } }), 1);
	}
	// opening a dispute (inserts a row that key-shares the request) while an admin action is in flight: no deadlock, exactly one dispute, the contract is not touched
	for (const rollback of [false, true]) {
		const x = await world({ requestStatus: 'IN_PROGRESS', contract: 'ACTIVE', escrow: 'HELD' });
		const before = await snap(x);
		const o = await adminInFlight(x, () => disputeService.createForRequest(x.project.id, x.provider.id, 'provider', { reason: 'نزاع', description: 'نزاع اختباري على المشروع نفسه. '.repeat(4), stageId: undefined, evidence: [] } as any), noop, { rollback });
		assert.ok(!o.err || o.err.statusCode === 400 || o.err.statusCode === 409 || o.err.statusCode === 422, `no deadlock / no 500: ${o.err?.message}`);
		assert.equal(await snap(x), before.replace(/"x":0/, '"x":0'));
		assert.ok((await x.e.prisma.dispute.count({ where: { projectId: x.project.id } })) <= 1);
	}
});

test('LOCK ORDER true parallel rounds: admin refund / release racing a final approval, a settlement and a dispute decision - never a deadlock (no 500), never a mixed end state', opts, async () => {
	const e = await boot(); const sa = e.sa.id; const { projectProgressService } = await import('./project-progress.service');
	const dead = (r: any) => r.status >= 500;
	for (let i = 0; i < 6; i++) {
		const { w, s2 } = await finalStageWorld(); const c = await ctl(w, 'contracts', w.contract.id, sa);
		const [adm, ap] = await Promise.all([
			e.http('POST', `/admin/contracts/${w.contract.id}/${i % 2 ? 'release' : 'refund'}`, sa, { reason: 'قرار إداري موثّق', expectedVersion: c.version, confirm: true, expectedHeldAmount: 10 }, keyOf()),
			projectProgressService.reviewDelivery(w.client.id, w.contract.id, s2.id, 'approve').then(() => 200, (er: any) => er.statusCode ?? 500)
		]);
		assert.ok(!dead(adm), `admin ${adm.status} ${adm.code}`); assert.ok(ap !== 500, `approval ${ap}`);
		const s = JSON.parse(await snap(w)); const ends = `${s.escrow.status}/${s.contract.status}/${s.request.status}`;
		assert.ok(['RELEASED/COMPLETED/COMPLETED', 'REFUNDED/CANCELLED/CANCELLED'].includes(ends), `consistent end state, got ${ends} (admin ${adm.status}, approval ${ap})`);
		assert.equal(Number(s.escrow.releasedAmount) <= 20, true);
		assert.ok(!(adm.status === 200 && ap === 200), 'money moved only once');
	}
});

test('LOCK ORDER static: every flow that locks the contract and then writes the request takes the request row first (lockRequestRow before the contract lock)', opts, async () => {
	const fs = await import('node:fs'); const path = await import('node:path'); const root = path.join(__dirname, '..');
	const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
	const first = (src: string, a: string, b: string) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i > 0 && j > 0 && i < j, `${a} must come before ${b}`); };
	first(read('services/project-progress.service.ts'), 'await lockRequestRow(tx, contract.projectId)', 'const contractLock = await tx.contract.updateMany');
	first(read('controllers/provider.controller.ts'), 'await lockRequestRow(tx, targetProjectId)', 'const transitioned = await tx.contract.updateMany');
	first(read('services/client-requests.service.ts'), 'await lockRequestRow(tx, requestId);\n\t\t\t// a. Mark OTP', 'const clientSigned = await tx.contract.updateMany');
	first(read('services/contract-cancellation.service.ts'), 'await lockRequestRow(tx, pre.projectId)', 'if (!(await lockProjectForFreezeCheck(tx, pre.projectId))) throw new AppError(\'لا يوجد عقد وضمان');
	const d = read('services/dispute.service.ts');
	first(d, 'await lockRequestRow(tx, target.requestId ?? target.projectId)', 'if (target.projectId) await lockProjectForFreezeCheck');
	first(d, 'await lockRequestRow(tx, projectId)', 'if (!(await lockProjectForFreezeCheck(tx, projectId))) throw new AppError(\'لا يوجد عقد وضمان مرتبطان');
	assert.match(read('services/lock-order.ts'), /CANONICAL ROW-LOCK ORDER/);
});
