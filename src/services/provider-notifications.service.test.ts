import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
// e-mail links always carry the site host (utils/site-url): the tests that look at the link configure it
process.env.FRONTEND_URL = 'https://dev.example.test';

process.env.OPENAI_API_KEY = 'test-key';

// Every provider-facing event gets a stored notification with an actionUrl that opens a REAL provider route. REAL_PROVIDER_ROUTES mirrors the
// patterns in angular-app/src/app/pages/dashboard/provider-overview/provider.routes.ts (only the ones a notification can point at).
const REAL_PROVIDER_ROUTES = [
	/^\/provider-overview\/disputes\/[^/]+$/,
	/^\/provider-overview\/profile\/public$/,
	/^\/provider-overview\/profile\/data$/,
	/^\/provider-overview\/finance\/withdraw$/,
	/^\/provider-overview\/projects\/active\/progress\/[^/]+$/,
	// the provider's rating page of a project (provider.routes.ts: projects/:id/rating)
	/^\/provider-overview\/projects\/[^/]+\/rating$/,
	/^\/provider-overview\/offers\/[^/]+\/sign-contract$/,
	/^\/provider-overview\/explore-requests\/[^/]+\/apply$/,
	/^\/provider-overview\/offers$/,
	/^\/provider-overview\/offers\/[^/]+\/negotiate$/
];
const isRealProviderRoute = (url: unknown) => typeof url === 'string' && REAL_PROVIDER_ROUTES.some(r => r.test(url));

interface Fixture { notifications: any[]; mails: any[]; pushes: any[]; }

// notification.service (and its db / mail / socket dependencies) is imported once and cached for the whole file, so the mocks it holds delegate to the
// fixture of the CURRENT test.
let current: Fixture & { prisma: any };
const delegatingPrisma = new Proxy({}, { get: (_t, key) => current.prisma[key as string] });

async function load(t: TestContext, opts: { preferences?: unknown; withdrawal?: any; owner?: any; db?: Record<string, any> } = {}) {
	const f: Fixture = { notifications: [], mails: [], pushes: [] };
	const withdrawal = opts.withdrawal === undefined ? { id: 'w1', userId: 'prov-1', amount: 120, currency: 'USD', rejectionReason: 'بيانات غير مكتملة' } : opts.withdrawal;
	const prisma = {
		notification: { create: async ({ data }: any) => { const row = { id: `n${f.notifications.length + 1}`, actionText: null, metadata: null, isRead: false, createdAt: new Date(), ...data }; f.notifications.push(row); return row; } },
		providerProfile: { findUnique: async () => ({ preferences: opts.preferences, user: { email: 'p@example.com', firstName: 'سارة' } }) },
		withdrawal: { findUnique: async () => withdrawal },
		user: { findUnique: async () => opts.owner ?? { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null } },
		...opts.db
	};
	current = Object.assign(f, { prisma });
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (o: any) => { current.mails.push(o); return {}; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
	t.mock.module('../socket', { namedExports: { getIO: () => ({ to() { return this; }, emit: (_e: string, d: any) => current.pushes.push(d) }) } });
	t.mock.module('../config/db', { namedExports: { prisma: delegatingPrisma } });
	return f;
}
const settle = () => new Promise(r => setTimeout(r, 20));
const fresh = async (path: string) => import(`${path}?fixture=${Date.now()}-${Math.random()}`);

test('dispute opened by the client: the provider it is against is notified with a real dispute route', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.disputeOpened({ disputeId: 'd1', providerId: 'prov-1', openedBy: 'client', requestTitle: 'متجر إلكتروني' });
	assert.equal(f.notifications.length, 1);
	assert.equal(f.notifications[0].userId, 'prov-1');
	assert.equal(f.notifications[0].type, 'DISPUTE_OPENED');
	assert.equal(f.notifications[0].category, 'PROJECTS');
	assert.equal(f.notifications[0].title, 'تم فتح نزاع ضدك');
	assert.equal(f.notifications[0].actionUrl, '/provider-overview/disputes/d1');
	assert.ok(f.notifications[0].actionText);
	assert.ok(isRealProviderRoute(f.notifications[0].actionUrl));
});

test('dispute opened by the provider: the provider gets a confirmation, not the "against you" wording', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.disputeOpened({ disputeId: 'd2', providerId: 'prov-1', openedBy: 'provider' });
	assert.equal(f.notifications[0].title, 'تم تسجيل نزاعك');
	assert.ok(isRealProviderRoute(f.notifications[0].actionUrl));
});

test('dispute resolved / rejected: provider notified with the admin resolution and a real route; no provider means no notification', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.disputeResolved({ disputeId: 'd1', providerId: 'prov-1', action: 'resolve', resolution: 'إفراج جزئي' });
	await providerNotifications.disputeResolved({ disputeId: 'd1', providerId: 'prov-1', action: 'reject', resolution: 'لا يوجد أساس' });
	await providerNotifications.disputeResolved({ disputeId: 'd1', providerId: null, action: 'resolve' });
	assert.equal(f.notifications.length, 2);
	assert.equal(f.notifications[0].title, 'تم حسم النزاع');
	assert.match(f.notifications[0].message, /إفراج جزئي/);
	assert.equal(f.notifications[1].title, 'تم إغلاق النزاع دون قبوله');
	assert.ok(f.notifications.every(n => n.type === 'DISPUTE_RESOLVED' && isRealProviderRoute(n.actionUrl)));
});

test('rating received (project and stage): provider notified with the score and a real route', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.ratingReceived({ providerId: 'prov-1', rating: 4, reviewId: 'r1', projectId: 'p1' });
	await providerNotifications.ratingReceived({ providerId: 'prov-1', rating: 5, reviewId: 'r2', projectId: 'p1', stage: true });
	assert.equal(f.notifications.length, 2);
	assert.ok(f.notifications.every(n => n.type === 'RATING_RECEIVED' && n.category === 'PROJECTS' && isRealProviderRoute(n.actionUrl)));
	assert.match(f.notifications[0].message, /4 من 5/);
	assert.equal(f.notifications[1].title, 'تقييم جديد على مرحلة');
});

test('every withdrawal state produces its own FINANCIAL notification with a real route', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	for (const e of ['REQUESTED', 'APPROVED', 'REJECTED', 'PAID', 'FAILED', 'REVERSED'] as const) await providerNotifications.withdrawal('w1', e);
	assert.deepEqual(f.notifications.map(n => n.type), ['WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_FAILED', 'WITHDRAWAL_REVERSED']);
	assert.equal(new Set(f.notifications.map(n => n.title)).size, 6);
	assert.ok(f.notifications.every(n => n.userId === 'prov-1' && n.category === 'FINANCIAL' && n.actionText && isRealProviderRoute(n.actionUrl)));
	assert.match(f.notifications[2].message, /بيانات غير مكتملة/);
	assert.match(f.notifications[0].message, /120 \$/);
});

test('a marketer (commission) withdrawal is handed to the marketer helper: the provider helper stays silent (no duplicate), the marketer helper sends marketer wording and the marketer withdraw route', async t => {
	const f = await load(t, { owner: { accountType: 'MARKETER', roles: ['AFFILIATE'], activeRole: 'AFFILIATE', affiliateProfile: { id: 'a1' } } });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
	await providerNotifications.withdrawal('w1', 'APPROVED');
	await settle();
	assert.equal(f.notifications.length, 0);
	await marketerNotifications.withdrawal('w1', 'APPROVED');
	await settle();
	assert.equal(f.notifications.length, 1);
	assert.equal(f.notifications[0].actionUrl, '/marketer-overview/withdraw');
	assert.equal(f.notifications[0].type, 'WITHDRAWAL_APPROVED');
});

test('a missing withdrawal is a no-op', async t => {
	const f = await load(t, { withdrawal: null });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.withdrawal('w1', 'APPROVED');
	assert.equal(f.notifications.length, 0);
});

test('PayPal email change and amendment answer: real routes (the old "/" link is gone)', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.paypalEmailChanged('prov-1');
	await providerNotifications.amendmentAnswered({ providerId: 'prov-1', projectId: 'p1', amendmentId: 'a1', title: 'تمديد المدة', decision: 'approve' });
	assert.equal(f.notifications[0].type, 'PAYPAL_EMAIL_CHANGED');
	assert.equal(f.notifications[0].actionUrl, '/provider-overview/profile/data');
	assert.equal(f.notifications[1].type, 'PROJECT_AMENDMENT');
	assert.ok(f.notifications.every(n => isRealProviderRoute(n.actionUrl)));
});

test('channel preferences: e-mail only = stored + mail in the chosen language (no push)', async t => {
	const email = await load(t, { preferences: { notifChannels: ['email'], preferredCommunicationLanguage: 'en' } });
	const mod = await fresh('./provider-notifications.service.ts');
	await mod.providerNotifications.withdrawal('w1', 'APPROVED');
	await settle();
	assert.equal(email.notifications.length, 1);
	assert.equal(email.pushes.length, 0);
	assert.equal(email.mails.length, 1);
	assert.equal(email.mails[0].to, 'p@example.com');
	assert.match(email.mails[0].html, /Hello/);
	assert.match(email.mails[0].html, /\/provider-overview\/finance\/withdraw/);

});

test('channel preferences: push only = stored + push (no mail)', async t => {
	const push = await load(t, { preferences: { notifChannels: ['push'] } });
	const mod = await fresh('./provider-notifications.service.ts');
	await mod.providerNotifications.ratingReceived({ providerId: 'prov-1', rating: 5, reviewId: 'r1' });
	await settle();
	assert.equal(push.notifications.length, 1);
	assert.equal(push.pushes.length, 1);
	assert.equal(push.mails.length, 0);

});

test('channel preferences: nothing saved = stored + push, no mail', async t => {
	const none = await load(t, { preferences: null });
	const mod = await fresh('./provider-notifications.service.ts');
	await mod.providerNotifications.paypalEmailChanged('prov-1');
	await settle();
	assert.equal(none.pushes.length, 1);
	assert.equal(none.mails.length, 0);
});

test('a notification failure never fails the business action', async t => {
	await load(t, { db: { notification: { create: async () => { throw new Error('db down'); } } } });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.paypalEmailChanged('prov-1');
	await providerNotifications.ratingReceived({ providerId: 'prov-1', rating: 5, reviewId: 'r1' });
});

test('negotiation requested / offer selected: provider notified with OFFERS category, real route, action text; e-mail-only preference respected', async t => {
	const f = await load(t, { preferences: { notifChannels: ['email'], preferredCommunicationLanguage: 'ar' } });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.negotiationRequested({ providerId: 'prov-1', offerId: 'o1', projectId: 'p1', requestTitle: 'متجر' });
	await providerNotifications.offerSelected({ providerId: 'prov-1', offerId: 'o1', projectId: 'p1', requestTitle: 'متجر' });
	await settle();
	assert.equal(f.notifications.length, 2);
	const [neg, sel] = f.notifications;
	assert.equal(neg.type, 'OFFER_NEGOTIATION_REQUESTED');
	assert.equal(neg.category, 'OFFERS');
	assert.equal(neg.userId, 'prov-1');
	assert.equal(neg.actionUrl, '/provider-overview/offers/o1/negotiate');
	assert.equal(neg.actionText, 'عرض التفاوض');
	assert.equal(sel.type, 'OFFER_SELECTED');
	assert.equal(sel.category, 'OFFERS');
	assert.equal(sel.actionUrl, '/provider-overview/offers');
	assert.equal(sel.actionText, 'عرض عروضي');
	assert.ok(f.notifications.every(n => isRealProviderRoute(n.actionUrl)));
	// e-mail-only preference: mails sent, no push
	assert.equal(f.mails.length, 2);
	assert.equal(f.pushes.length, 0);
});

test('negotiation / selection: a notification failure never fails the action', async t => {
	await load(t, { db: { notification: { create: async () => { throw new Error('db down'); } } } });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.negotiationRequested({ providerId: 'prov-1', offerId: 'o1', projectId: 'p1' });
	await providerNotifications.offerSelected({ providerId: 'prov-1', offerId: 'o1', projectId: 'p1' });
});

test('negotiation / selection: push-only preference = stored + push, no mail', async t => {
	const f = await load(t, { preferences: { notifChannels: ['push'] } });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.offerSelected({ providerId: 'prov-1', offerId: 'o1', projectId: 'p1' });
	await settle();
	assert.equal(f.notifications.length, 1);
	assert.equal(f.pushes.length, 1);
	assert.equal(f.mails.length, 0);
});

// ─── The services call the right notification at the right moment ────────────────────────────────────────────────

test('disputeService: client opens -> provider (against) notified; provider opens -> provider notified; admin resolve -> provider notified', async t => {
	const calls: any[] = [];
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { disputeOpened: async (a: any) => { calls.push(['opened', a]); }, disputeResolved: async (a: any) => { calls.push(['resolved', a]); } } } });
	const prismaMock: any = {};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	Object.assign(prismaMock, {
		project: { findUnique: async () => null },
		clientRequest: { findUnique: async () => ({ id: 'req-1', title: 'طلب', status: 'IN_PROGRESS', clientProfile: { userId: 'client-1' }, proposals: [{ id: 'pr1', status: 'ACCEPTED', providerId: 'prov-1' }] }) },
		proposal: { findFirst: async () => ({ providerId: 'prov-1' }) },
		dispute: {
			findFirst: async () => null,
			create: async ({ data }: any) => ({ id: 'd1', ...data, request: { id: 'req-1', title: 'طلب' } }),
			findUnique: async () => ({ id: 'd1', status: 'OPEN', requestId: 'req-1', projectId: null }),
			update: async () => ({ id: 'd1', status: 'RESOLVED' }),
			updateMany: async () => ({ count: 1 })
		},
		$queryRaw: async () => [{ id: 'c1' }],
		$transaction: async (fn: any) => fn(prismaMock)
	});
	const { disputeService } = await fresh('./dispute.service.ts');
	const input = { reason: 'تأخر التسليم', description: 'وصف طويل بما يكفي للنزاع', evidence: [] };
	await disputeService.createForRequest('req-1', 'client-1', 'client', input);
	await disputeService.createForRequest('req-1', 'prov-1', 'provider', input);
	await disputeService.resolve('d1', 'admin-1', { action: 'resolve', resolution: 'تسوية' });
	assert.deepEqual(calls.map(c => c[0]), ['opened', 'opened', 'resolved']);
	assert.equal(calls[0][1].providerId, 'prov-1');
	assert.equal(calls[0][1].openedBy, 'client');
	assert.equal(calls[1][1].providerId, 'prov-1');
	assert.equal(calls[1][1].openedBy, 'provider');
	assert.deepEqual([calls[2][1].disputeId, calls[2][1].providerId, calls[2][1].action], ['d1', 'prov-1', 'resolve']);
});

test('ratingService: a client rating notifies the provider; a provider rating of the client notifies the CLIENT, never the provider', async t => {
	const calls: any[] = [];
	const clientCalls: any[] = [];
	t.mock.module('./client-notifications.service', { namedExports: { clientNotifications: { send: async (n: any) => { clientCalls.push(n); } }, clientNotificationFor: { ratingReceived: (p: any) => ({ type: 'RATING_RECEIVED', ...p }) } } });
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { ratingReceived: async (a: any) => { calls.push(a); } } } });
	const tx = {
		$executeRaw: async () => 1,
		review: { findFirst: async () => null, create: async ({ data }: any) => ({ id: 'rev-1', ...data }), aggregate: async () => ({ _avg: { rating: 4 } }) },
		user: { update: async () => ({}) },
		pointTransaction: { aggregate: async () => ({ _sum: { amount: 0 } }) },
		project: { count: async () => 0, findUnique: async () => ({ serviceCatalogId: null }) },
		providerGamification: { updateMany: async () => ({ count: 1 }) }
	};
	t.mock.module('../config/db', { namedExports: { prisma: {
		clientRequest: { findUnique: async () => null },
		dispute: { findFirst: async () => null },
		contract: { findUnique: async () => ({ id: 'c1', providerId: 'prov-1', clientId: 'client-1', projectId: 'p1', status: 'COMPLETED', project: { id: 'p1', status: 'COMPLETED' } }) },
		project: { findUnique: async () => ({ serviceCatalogId: null }) },
		review: { findFirst: async () => null },
		$transaction: async (fn: any) => fn(tx)
	} } });
	const { ratingService } = await fresh('./rating.service.ts');
	await ratingService.rateRequest('c1', 'client-1', 'client', { rating: 5 });
	await ratingService.rateRequest('c1', 'prov-1', 'provider', { rating: 3 });
	assert.equal(calls.length, 1);
	assert.deepEqual([calls[0].providerId, calls[0].rating, calls[0].reviewId, calls[0].projectId], ['prov-1', 5, 'rev-1', 'p1']);
	assert.equal(clientCalls.length, 1);
	assert.deepEqual([clientCalls[0].clientId, clientCalls[0].rating], ['client-1', 3]);
});

test('withdrawalService.reject notifies REJECTED; payoutService completed / failed / reversed notify only on a real transition', async t => {
	const calls: any[] = [];
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { withdrawal: async (id: string, e: string) => { calls.push([id, e]); } } } });
	let attemptCount = 1;
	const tx = {
		withdrawal: { updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => ({ id: 'w1', status: 'REJECTED' }) },
		payoutAttempt: {
			updateMany: async () => ({ count: attemptCount }),
			findUniqueOrThrow: async () => ({ id: 'at1', withdrawalId: 'w1', status: 'X' }),
			findUnique: async () => ({ id: 'at1', withdrawalId: 'w1', status: 'COMPLETED' })
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: {
		withdrawal: { findUnique: async () => ({ id: 'w1', status: 'PENDING' }) },
		$transaction: async (fn: any) => fn(tx)
	} } });
	const { withdrawalService } = await fresh('./withdrawal.service.ts');
	const { payoutService } = await fresh('./payout.service.ts');
	await withdrawalService.reject('w1', 'admin-1', { rejectionReason: 'بيانات غير مكتملة' });
	await payoutService.markAttemptCompleted('at1');
	await payoutService.markAttemptDefinitelyFailed('at1', 'x');
	await payoutService.markAttemptReversed('at1', 'RETURNED');
	assert.deepEqual(calls, [['w1', 'REJECTED'], ['w1', 'PAID'], ['w1', 'FAILED'], ['w1', 'REVERSED']]);
	// A duplicate delivery (the attempt is already terminal, nothing transitions) must not notify twice.
	attemptCount = 0;
	calls.length = 0;
	await payoutService.markAttemptCompleted('at1');
	await payoutService.markAttemptDefinitelyFailed('at1', 'x');
	assert.equal(calls.length, 0);
});

test('counter accepted: the provider gets a stored notification with the new terms and the real negotiate route', async t => {
	const f = await load(t);
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await providerNotifications.counterAccepted({ providerId: 'prov-1', offerId: 'offer-1', projectId: 'req-1', projectTitle: 'متجر إلكتروني', price: 880, deliveryDays: 18 });
	assert.equal(f.notifications.length, 1);
	const n = f.notifications[0];
	assert.equal(n.userId, 'prov-1');
	assert.equal(n.type, 'OFFER_COUNTER_ACCEPTED');
	assert.equal(n.category, 'OFFERS');
	assert.match(n.message, /880 \$ خلال 18 يومًا/);
	assert.equal(n.actionUrl, '/provider-overview/offers/offer-1/negotiate');
	assert.ok(isRealProviderRoute(n.actionUrl));
});

test('counter accepted: a failing notification never throws into the accept action', async t => {
	await load(t, { db: { notification: { create: async () => { throw new Error('db down'); } } } });
	const { providerNotifications } = await fresh('./provider-notifications.service.ts');
	await assert.doesNotReject(providerNotifications.counterAccepted({ providerId: 'prov-1', offerId: 'offer-1', projectId: 'req-1', price: 1, deliveryDays: 1 }));
});
