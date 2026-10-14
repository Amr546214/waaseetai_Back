import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// The fixes of the live end-to-end findings, exercised TOGETHER through the real routers (fake prisma only): no fabricated project details (1), provider routes closed to other
// roles (2), money without float noise (3), the client tracking built from the contract's real stages (4), the provider active list agreeing with the progress endpoint (5),
// and the honest amendment payload (6). The figures are the ones of the live run (level 1 = 12.75%).
process.env.JWT_SECRET = 'e2e-findings-secret';
process.env.OPENAI_API_KEY = 'x';
const users: Record<string, any> = {
	client: { id: 'client', email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	marketer: { id: 'marketer', email: 'm@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE'] },
	admin: { id: 'admin', email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	provider: { id: 'provider', email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] },
};
const day = 86400000;
const signedAt = new Date(Date.now() - 2 * day);
const st = (o: any) => ({ contractId: 'ct1', description: null, percentage: 50, deliveries: [], stageReviews: [], createdAt: signedAt, updatedAt: signedAt, ...o });

// mutable fixtures
const fx: any = {
	escrows: [] as any[],
	stages: [] as any[], // contract ct1 ProjectStage rows (the provider list lazily creates them from the offer)
	createdFromOffer: false,
	project: { id: 'p1', title: 'مشروع تطوير', description: '', specialty: '', subSpecialties: [], requirements: [], outputs: null, customConditions: null, deliveryDays: 10, budgetType: 'fixed', budgetMin: null, budgetMax: null, budgetFixed: 50, budgetHourly: null, status: 'IN_PROGRESS', createdAt: signedAt, updatedAt: signedAt, _count: { proposals: 0, projectProposals: 1 }, client: { id: 'client', firstName: 'ع', lastName: 'م', avatarUrl: null, clientProfile: null } },
};
const contractBase = () => ({ id: 'ct1', projectId: 'p1', clientId: 'client', providerId: 'provider', offerId: 'offer1', price: 50, durationDays: 10, phasesCount: 2, status: 'ACTIVE', signedAt, createdAt: signedAt, terms: null, updatedAt: signedAt });
const modelProxy = () => new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({
	user: { findUnique: async ({ where }: any) => users[where.id] ?? null },
	project: {
		findUnique: async () => fx.project,
		findFirst: async () => ({ ...fx.project, projectProposals: [], proposals: [] }),
	},
	clientRequest: { findFirst: async () => null },
	escrow: {
		findMany: async () => fx.escrows,
		findUnique: async () => ({ status: 'HELD', amount: 50, releasedAmount: 0 }),
	},
	withdrawal: { groupBy: async () => [] },
	contract: {
		findFirst: async ({ where }: any) => where?.OR
			? { ...contractBase(), project: { ...fx.project, escrow: { status: 'HELD', amount: 50, releasedAmount: 0, platformCommissionAmount: 0, providerNetReleasedAmount: 0 }, conversations: [{ providerId: 'provider', clientId: 'client', messages: [] }], assignedEmployee: null }, client: { id: 'client', firstName: 'ع', lastName: 'م' }, provider: { id: 'provider', firstName: 'م', lastName: 'ز' } }
			: { price: 50, signedAt, stages: fx.stages.map((s: any) => ({ ...s })) },
		findMany: async () => [{ ...contractBase(), project: { ...fx.project, escrow: { status: 'HELD', amount: 50, releasedAmount: 0 } }, client: { firstName: 'ع', lastName: 'م' }, stages: fx.stages.map((s: any) => ({ ...s })) }],
		findUnique: async () => ({ ...contractBase(), project: fx.project }),
	},
	projectProposal: {
		findUnique: async () => ({ milestones: [{ stepOrder: 1, title: 'التحليل', description: 'د', days: 4, percentage: 50, amount: 25 }, { stepOrder: 2, title: 'التنفيذ', description: 'د', days: 6, percentage: 50, amount: 25 }] }),
		findFirst: async () => null,
	},
	projectStage: {
		findMany: async () => fx.stages.map((s: any) => ({ ...s })),
		createMany: async ({ data }: any) => { fx.createdFromOffer = true; fx.stages = data.map((d: any, i: number) => st({ id: `s${i + 1}`, ...d })); return { count: data.length }; },
	},
	dispute: { findMany: async () => [], findFirst: async () => null },
	conversation: { upsert: async () => ({ messages: [] }) },
	review: { findFirst: async () => null },
}, { get: (t: any, k: string) => t[k] ?? modelProxy() });

let srv: Promise<{ url: string }> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }), revokeSession: async () => ({}), revoke: async () => ({}) } } });
		mock.module('../services/provider-access-state.service', { namedExports: {
			DASHBOARD_LOCKED_MESSAGE: 'locked',
			providerAccessStateService: { get: async () => ({ state: 'APPROVED', canAccessDashboard: true, message: '', reason: null, hasSample: true, specialties: [] }) },
		} });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		app.use('/provider', (await import('./provider.routes')).default);
		app.use('/client/requests', (await import('./client-requests.routes')).default);
		app.use('/projects', (await import('./project.routes')).default);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		s.unref();
		return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
	})();
	return srv;
}
async function call(as: string | null, method: string, path: string) {
	const { url } = await server();
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	const res = await fetch(`${url}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify({}) });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
function allNumbers(value: any, path = '', out: [string, number][] = []): [string, number][] {
	if (typeof value === 'number') out.push([path, value]);
	else if (Array.isArray(value)) value.forEach((v, i) => allNumbers(v, `${path}[${i}]`, out));
	else if (value && typeof value === 'object' && !(value instanceof Date)) for (const [k, v] of Object.entries(value)) allNumbers(v, `${path}.${k}`, out);
	return out;
}

// escrow rows in the live-run shapes: level 1 = 12.75%
const v2 = (o: any) => ({ id: 'e', status: 'HELD', updatedAt: new Date('2026-10-12'), createdAt: new Date('2026-10-10'), feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, platformCommissionAmount: 0, project: { id: 'p', title: 'T', status: 'IN_PROGRESS', contract: { price: 20, stages: [] } }, ...o });
const stage = (id: string, amount: number, d: string) => ({ id, title: id, amount, approvedAt: new Date(d) });

test('(3) provider wallet: escrow held 17.45 - 8.72 = 8.73 (not 8.729999999999999), commission split 1.28/1.27', async () => {
	assert.notEqual(17.45 - 8.72, 8.73, 'the raw float subtraction is the bug being fixed');
	fx.escrows = [v2({ id: 'e20', amount: 20, releasedAmount: 10, providerNetReleasedAmount: 8.72, platformCommissionAmount: 1.28, project: { id: 'p20', title: 'T20', status: 'IN_PROGRESS', contract: { price: 20, stages: [stage('s1', 10, '2026-10-11')] } } })];
	const r = await call('provider', 'GET', '/provider/finance/wallet');
	assert.equal(r.status, 200);
	const { summary, escrows, transactions } = r.body.data;
	assert.equal(escrows[0].held, 8.73);
	assert.equal(escrows[0].total, 17.45);
	assert.equal(escrows[0].released, 8.72);
	assert.equal(summary.escrowBalance, 8.73);
	assert.equal(transactions[0].amount, 8.72);
	assert.equal(transactions[0].platformCommission, 1.28);
	for (const [p, n] of allNumbers(r.body.data)) assert.ok(decimals(n) <= 2, `${p} = ${n}`);
});
test('(3) provider wallet: earnings 17.45 + 43.62 = 61.07 and the 70 USD stage commission is 8.93', async () => {
	assert.notEqual(17.45 + 43.62, 61.07, 'raw float sum is noisy');
	fx.escrows = [
		v2({ id: 'a', amount: 20, status: 'RELEASED', releasedAmount: 20, providerNetReleasedAmount: 17.45, platformCommissionAmount: 2.55, project: { id: 'pa', title: 'A', status: 'COMPLETED', contract: { price: 20, stages: [stage('a1', 10, '2026-10-01'), stage('a2', 10, '2026-10-02')] } } }),
		v2({ id: 'b', amount: 50, status: 'RELEASED', releasedAmount: 50, providerNetReleasedAmount: 43.62, platformCommissionAmount: 6.38, project: { id: 'pb', title: 'B', status: 'COMPLETED', contract: { price: 50, stages: [stage('b1', 50, '2026-10-03')] } } }),
		v2({ id: 'c', amount: 70, status: 'RELEASED', releasedAmount: 70, providerNetReleasedAmount: 61.07, platformCommissionAmount: 8.93, project: { id: 'pc', title: 'C', status: 'COMPLETED', contract: { price: 70, stages: [stage('c1', 70, '2026-10-04')] } } }),
	];
	const r = await call('provider', 'GET', '/provider/finance/wallet');
	const { summary, transactions } = r.body.data;
	assert.equal(summary.availableBalance, 122.14);
	assert.equal(summary.totalEarnings, 122.14);
	assert.equal(summary.platformCommissionTotal, 17.86);
	const c1 = transactions.find((t: any) => t.stageId === 'c1');
	assert.equal(c1.platformCommission, 8.93);
	assert.equal(c1.amount, 61.07);
	// the 20 USD contract: total commission 2.55, stage nets 8.72 / 8.73
	const a = transactions.filter((t: any) => String(t.stageId).startsWith('a')).sort((x: any, y: any) => x.stageId.localeCompare(y.stageId));
	assert.deepEqual(a.map((t: any) => [t.platformCommission, t.amount]), [[1.28, 8.72], [1.27, 8.73]]);
	for (const [p, n] of allNumbers(r.body.data)) assert.ok(decimals(n) <= 2, `${p} = ${n}`);
});

test('(3) provider wallet: two escrows 17.45 + 43.62 => availableBalance 61.07', async () => {
	fx.escrows = [
		v2({ id: 'a', amount: 20, status: 'RELEASED', releasedAmount: 20, providerNetReleasedAmount: 17.45, project: { id: 'pa', title: 'A', status: 'COMPLETED', contract: { price: 20, stages: [] } } }),
		v2({ id: 'b', amount: 50, status: 'RELEASED', releasedAmount: 50, providerNetReleasedAmount: 43.62, project: { id: 'pb', title: 'B', status: 'COMPLETED', contract: { price: 50, stages: [] } } }),
	];
	const { summary } = (await call('provider', 'GET', '/provider/finance/wallet')).body.data;
	assert.equal(summary.availableBalance, 61.07);
	assert.equal(summary.totalEarnings, 61.07);
});

test('(2) other roles cannot read the provider wallet; the provider can', async () => {
	fx.escrows = [];
	for (const who of ['client', 'marketer', 'admin']) assert.equal((await call(who, 'GET', '/provider/finance/wallet')).status, 403, who);
	assert.equal((await call(null, 'GET', '/provider/finance/wallet')).status, 401);
	assert.equal((await call('provider', 'GET', '/provider/finance/wallet')).status, 200);
	for (const who of ['client', 'marketer', 'admin']) for (const p of ['/provider/projects/active', '/provider/finance/transactions', '/provider/offers']) assert.equal((await call(who, 'GET', p)).status, 403, `${who} ${p}`);
});

test('(1) project summary invents nothing: no placeholder requirements / outputs / specialty / description', async () => {
	const r = await call('provider', 'GET', '/projects/p1/summary');
	assert.equal(r.status, 200);
	const d = r.body.data;
	assert.deepEqual(d.requirements, []);
	assert.equal(d.outputs, '');
	assert.equal(d.specialty, '');
	assert.equal(d.description, '');
	const text = JSON.stringify(d);
	for (const fake of ['Adobe Illustrator', 'ملفات قابلة للتعديل', '3+ سنوات خبرة', 'شعار بصيغ متعددة', 'تصميم جرافيك', 'لا يوجد وصف']) assert.ok(!text.includes(fake), fake);
	// real values pass through untouched
	fx.project = { ...fx.project, description: 'وصف حقيقي', specialty: 'تطوير الخلفية', requirements: ['Node.js', 'PostgreSQL'], outputs: 'API موثق + اختبارات' };
	const real = (await call('provider', 'GET', '/projects/p1/summary')).body.data;
	assert.deepEqual([real.description, real.specialty, real.requirements, real.outputs], ['وصف حقيقي', 'تطوير الخلفية', ['Node.js', 'PostgreSQL'], 'API موثق + اختبارات']);
	fx.project = { ...fx.project, description: '', specialty: '', requirements: [], outputs: null };
});

test('(1) marketplace purchase fields come from the service: skills, stage titles, specialty nameAr, description; nothing invented when absent', async () => {
	const { deriveMarketplaceProjectFields } = await import('../services/cart-checkout.service');
	const d = deriveMarketplaceProjectFields(
		{ description: 'خدمة بناء API', skills: ['Node.js', 'PostgreSQL'], specialty: { name: 'Backend', nameAr: 'تطوير الخلفية' } },
		[{ title: 'التنفيذ', stepOrder: 2 }, { title: 'التحليل', stepOrder: 1 }]
	);
	assert.deepEqual(d, { description: 'خدمة بناء API', specialty: 'تطوير الخلفية', requirements: ['Node.js', 'PostgreSQL'], outputs: 'التحليل + التنفيذ' });
	assert.deepEqual(deriveMarketplaceProjectFields(undefined, []), { description: '', specialty: '', requirements: [], outputs: null });
	assert.notEqual(d.specialty, 'Marketplace');
});

test('(4) client tracking uses the contract ProjectStage rows (2 real stages 25/25), not one fake milestone', async () => {
	fx.stages = [st({ id: 's1', stepOrder: 1, title: 'التحليل', days: 4, amount: 25, status: 'APPROVED', approvedAt: new Date(), startedAt: signedAt }), st({ id: 's2', stepOrder: 2, title: 'التنفيذ', days: 6, amount: 25, status: 'IN_PROGRESS', startedAt: new Date() })];
	const r = await call('client', 'GET', '/client/requests/active-projects/p1');
	assert.equal(r.status, 200);
	const { project, timelines } = r.body.data ?? r.body;
	assert.equal(project.milestonesCount, 2);
	assert.equal(project.completedMilestones, 1);
	assert.equal(project.progress, 50);
	assert.deepEqual(timelines.map((t: any) => [t.title, t.amount, t.days, t.status]), [['التحليل', 25, 4, 'COMPLETED'], ['التنفيذ', 25, 6, 'IN_PROGRESS']]);
	assert.ok(!JSON.stringify(timelines).includes('تسليم المشروع النهائي'));
	assert.ok(!timelines.some((t: any) => String(t.id).startsWith('m-')));
});
test('(4) no stages and no milestones => nothing invented', async () => {
	fx.stages = [];
	const r = await call('client', 'GET', '/client/requests/active-projects/p1');
	const { project, timelines } = r.body.data ?? r.body;
	assert.equal(project.milestonesCount, 0);
	assert.deepEqual(timelines, []);
});

test('(5) provider active list resolves the offer-path stages like the progress endpoint: stage 1 current, canUploadDelivery true', async () => {
	fx.stages = []; fx.createdFromOffer = false;
	const list = await call('provider', 'GET', '/provider/projects/active');
	assert.equal(list.status, 200);
	const row = (list.body.data ?? list.body)[0];
	assert.equal(fx.createdFromOffer, true, 'stages were resolved from the accepted offer');
	assert.equal(row.currentStage, 'التحليل');
	assert.equal(row.canUploadDelivery, true);
	assert.equal(row.canSubmitDelivery, true);
	assert.equal(row.awaitingClientReview, false);
	assert.equal(row.stagesCount, 2);
	assert.ok(!JSON.stringify(row).includes('لم تُجهَّز'));
	const progress = await call('provider', 'GET', '/provider/projects/p1/progress');
	assert.equal(progress.status, 200);
	const p = progress.body.data;
	assert.equal(p.canUploadDelivery, row.canUploadDelivery);
	assert.equal(p.canSubmitDelivery, row.canSubmitDelivery);
	assert.equal(p.awaitingClientReview, row.awaitingClientReview);
	assert.equal(p.stages.find((s: any) => s.isWait)?.title, row.currentStage);
});
test('(5) a submitted stage: both endpoints agree on awaitingClientReview and no upload', async () => {
	fx.stages = [st({ id: 's1', stepOrder: 1, title: 'التحليل', days: 4, amount: 25, status: 'SUBMITTED', deliveries: [{ status: 'SUBMITTED', note: 'n', files: [], submittedAt: new Date(), id: 'd1' }] }), st({ id: 's2', stepOrder: 2, title: 'التنفيذ', days: 6, amount: 25, status: 'PENDING' })];
	const row = ((await call('provider', 'GET', '/provider/projects/active')).body.data)[0];
	const p = (await call('provider', 'GET', '/provider/projects/p1/progress')).body.data;
	assert.equal(row.awaitingClientReview, true);
	assert.equal(row.canUploadDelivery, false);
	assert.equal(p.awaitingClientReview, row.awaitingClientReview);
	assert.equal(p.canUploadDelivery, row.canUploadDelivery);
	assert.equal(row.currentStage, 'التحليل');
});

test('(6) every amendment payload says RECORD_ONLY, and the notifications say the decision changes nothing', async () => {
	const { AMENDMENT_EFFECT, AMENDMENT_EFFECT_NOTE } = await import('../services/project-amendment.service');
	assert.equal(AMENDMENT_EFFECT, 'RECORD_ONLY');
	assert.equal(AMENDMENT_EFFECT_NOTE, 'القرار يُسجَّل للمتابعة فقط ولا يغيّر سعر العقد أو مدته أو الضمان حاليًا.');
	const { clientNotificationFor } = await import('../services/client-notifications.service');
	for (const n of [
		clientNotificationFor.amendmentRequested({ clientId: 'c', projectId: 'p', amendmentId: 'a', title: 'زيادة' }),
		clientNotificationFor.amendmentAnswered({ clientId: 'c', projectId: 'p', amendmentId: 'a', title: 'زيادة', decision: 'approve' }),
		clientNotificationFor.amendmentAnswered({ clientId: 'c', projectId: 'p', amendmentId: 'a', title: 'زيادة', decision: 'reject' }),
	]) assert.ok(n.message.includes(AMENDMENT_EFFECT_NOTE), n.message);
});
