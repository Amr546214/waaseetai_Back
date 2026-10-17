import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// The real client routes (angular-app src/app/pages/dashboard/clients-overview/client.routes.ts, mounted at /client-overview), written as patterns.
// '/client-overview/projects/amendments' and '/projects/active' are declared BEFORE 'projects/:id', so they are real pages, not an id.
const REAL_CLIENT_ROUTES = [
	/^\/client-overview\/my-requests\/[^/]+$/,
	/^\/client-overview\/projects\/(active|amendments|archived|review)$/,
	/^\/client-overview\/projects\/[^/]+$/,
	/^\/client-overview\/projects\/[^/]+\/rating$/,
	/^\/client-overview\/projects\/[^/]+\/delivery-review\/[^/]+$/,
	/^\/client-overview\/disputes$/,
	/^\/client-overview\/profile$/,
	/^\/client-overview\/finance\/(wallet|transactions|invoices)$/
];
// a query string only selects what the page focuses on (e.g. ?dispute=<id>); the path itself must be a real route
const isRealClientRoute = (url: string) => REAL_CLIENT_ROUTES.some(r => r.test(url.split('?')[0]));

async function load(t: TestContext) {
	const created: any[] = [];
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (i: any) => { created.push(i); return i; }, emitStored: async () => ({}) } } });
	const mod = await import(`./client-notifications.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { ...mod, created };
}

test('every client event: right type, a title, a message and a REAL client route', async t => {
	const { clientNotificationFor: f } = await load(t);
	const c = 'client-1';
	const cases: Array<[string, any, string, RegExp]> = [
		['offerReceived', f.offerReceived({ clientId: c, requestId: 'r1', offerId: 'o1', requestTitle: 'موقع', providerName: 'سارة' }), 'NEW_PROPOSAL', /my-requests\/r1$/],
		['offerWithdrawn', f.offerWithdrawn({ clientId: c, requestId: 'r1', offerId: 'o1' }), 'OFFER_WITHDRAWN', /my-requests\/r1$/],
		['offerCounter', f.offerCounter({ clientId: c, requestId: 'r1', offerId: 'o1', messageId: 'm1', price: 120, deliveryDays: 5 }), 'OFFER_COUNTER', /my-requests\/r1$/],
		['negotiationDeclined', f.negotiationDeclined({ clientId: c, requestId: 'r1', offerId: 'o1', messageId: 'm1' }), 'OFFER_NEGOTIATION_REJECTED', /my-requests\/r1$/],
		['amendmentRequested', f.amendmentRequested({ clientId: c, projectId: 'p1', amendmentId: 'a1', title: 'زيادة' }), 'PROJECT_AMENDMENT', /projects\/amendments$/],
		['amendmentAnswered(approve)', f.amendmentAnswered({ clientId: c, projectId: 'p1', amendmentId: 'a1', title: 'زيادة', decision: 'approve' }), 'PROJECT_AMENDMENT', /projects\/amendments$/],
		['amendmentAnswered(reject)', f.amendmentAnswered({ clientId: c, projectId: 'p1', amendmentId: 'a1', title: 'زيادة', decision: 'reject' }), 'PROJECT_AMENDMENT', /projects\/amendments$/],
		['stageDelivered', f.stageDelivered({ clientId: c, projectId: 'p1', stageId: 's1', stageTitle: 'التصميم' }), 'STAGE_DELIVERY', /projects\/p1\/delivery-review\/s1$/],
		['stageApproved', f.stageApproved({ clientId: c, projectId: 'p1', stageId: 's1', stageTitle: 'التصميم', amount: 250 }), 'STAGE_APPROVED', /projects\/p1$/],
		['projectCompleted', f.projectCompleted({ clientId: c, projectId: 'p1', projectTitle: 'موقع' }), 'PROJECT_COMPLETED', /projects\/p1\/rating$/],
		['disputeOpened(client)', f.disputeOpened({ clientId: c, disputeId: 'd1', openedBy: 'client' }), 'DISPUTE_OPENED', /\/disputes\?dispute=d1$/],
		['disputeOpened(provider)', f.disputeOpened({ clientId: c, disputeId: 'd1', openedBy: 'provider' }), 'DISPUTE_OPENED', /\/disputes\?dispute=d1$/],
		['disputeResolved', f.disputeResolved({ clientId: c, disputeId: 'd1', action: 'resolve', resolution: 'استرداد' }), 'DISPUTE_RESOLVED', /\/disputes\?dispute=d1$/],
		['disputeResolved(reject)', f.disputeResolved({ clientId: c, disputeId: 'd1', action: 'reject' }), 'DISPUTE_RESOLVED', /\/disputes\?dispute=d1$/],
		['escrowFunded', f.escrowFunded({ clientId: c, requestId: 'r1', amount: 500, projectName: 'موقع' }), 'ESCROW_FUNDED', /projects\/active$/],
		['orderPaid(one)', f.orderPaid({ clientId: c, orderId: 'or1', orderNumber: 'ORD-1', total: 80, projectIds: ['p9'] }), 'ORDER_PAID', /projects\/p9$/],
		['orderPaid(many)', f.orderPaid({ clientId: c, orderId: 'or1', total: 80, projectIds: ['p9', 'p10'] }), 'ORDER_PAID', /projects\/active$/],
		['depositCompleted', f.depositCompleted({ clientId: c, transactionId: 'tx1', credited: 100, paid: 104, fee: 4 }), 'FINANCIAL', /finance\/wallet$/]
	];
	for (const [name, n, type, url] of cases) {
		assert.equal(n.userId, c, name);
		assert.equal(n.type, type, name);
		assert.ok(n.title && n.message && n.actionText, `${name}: title / message / actionText`);
		assert.match(n.actionUrl, url, name);
		assert.ok(isRealClientRoute(n.actionUrl), `${name}: ${n.actionUrl} is a real client route`);
		assert.doesNotMatch(n.actionUrl, /proposals|socket|undefined|null/, name);
	}
});

test('wording: no invented numbers, the amounts shown are the real ones passed in', async t => {
	const { clientNotificationFor: f } = await load(t);
	assert.match(f.stageApproved({ clientId: 'c', projectId: 'p', stageId: 's', stageTitle: 'المرحلة', amount: 250 }).message, /250 \$/);
	assert.match(f.escrowFunded({ clientId: 'c', requestId: 'r', amount: 500.5 }).message, /500.5 \$/);
	assert.match(f.offerCounter({ clientId: 'c', requestId: 'r', offerId: 'o', messageId: 'm', price: 120, deliveryDays: 5 }).message, /120 \$ خلال 5 يومًا/);
	assert.match(f.depositCompleted({ clientId: 'c', transactionId: 't', credited: 100, paid: 104, fee: 4 }).message, /100\.00 دولار.*104\.00.*4\.00/);
	assert.doesNotMatch(f.depositCompleted({ clientId: 'c', transactionId: 't', credited: 100, paid: 100, fee: 0 }).message, /رسوم/);
});

test('send: the notification goes through createAndEmit (stored + channel preferences); a failure never throws', async t => {
	const { clientNotifications, clientNotificationFor: f, created } = await load(t);
	await clientNotifications.send(f.stageDelivered({ clientId: 'c', projectId: 'p', stageId: 's', stageTitle: 'x' }));
	assert.equal(created.length, 1);
	assert.equal(created[0].type, 'STAGE_DELIVERY');
	await clientNotifications.send(null);
	assert.equal(created.length, 1);
});

test('the dead /projects/:id/proposals route is not used by any builder', async t => {
	const { CLIENT_ROUTES } = await load(t);
	for (const v of Object.values(CLIENT_ROUTES)) {
		const url = typeof v === 'function' ? (v as any)('x', 'y') : v;
		assert.ok(isRealClientRoute(url as string), String(url));
	}
});
