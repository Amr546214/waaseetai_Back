import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// The client side of a dispute: a confirmation when the client opens one, a heads-up when the provider opens one against the client,
// and the outcome when the admin closes it. Every link is the real /client-overview/disputes page.
const sent: any[] = [];
async function load(t: TestContext, o: { disputeFor?: any } = {}) {
	sent.length = 0;
	const dispute = { id: 'd1', requestId: null, projectId: 'p1', request: null, project: { id: 'p1', title: 'مشروع' } };
	t.mock.module('../config/db', { namedExports: { prisma: {
		clientRequest: { findUnique: async () => null },
		project: { findUnique: async (a: any) => (a.select?.contract ? { id: 'p1', clientId: 'client-1', providerId: 'prov-1', contract: { id: 'c1', status: 'ACTIVE', clientId: 'client-1', providerId: 'prov-1' } } : { providerId: 'prov-1', contract: { providerId: 'prov-1' } }) },
		dispute: {
			findFirst: async () => null,
			create: async () => dispute,
			findUnique: async () => o.disputeFor ?? { id: 'd1', requestId: null, projectId: 'p1', openedById: 'client-1', againstUserId: 'prov-1', status: 'OPEN' },
			update: async () => ({ id: 'd1' })
		}
	} } });
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { disputeOpened: async () => {}, disputeResolved: async () => {} } } });
	t.mock.module('./client-notifications.service', { namedExports: { clientNotifications: { send: async (n: any) => { sent.push(n); } }, clientNotificationFor: (await import('./client-notifications.service.ts?real=' + Math.random())).clientNotificationFor } });
	const { disputeService } = await import(`./dispute.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return disputeService;
}

test('the client opens a dispute: the client gets a confirmation linking to /client-overview/disputes', async t => {
	const svc = await load(t);
	await svc.createForRequest('p1', 'client-1', 'client', { reason: 'سبب كافٍ للنزاع', description: 'وصف كافٍ للنزاع هنا' });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].userId, 'client-1');
	assert.equal(sent[0].type, 'DISPUTE_OPENED');
	assert.equal(sent[0].actionUrl, '/client-overview/disputes');
});

test('the provider opens a dispute against the client: the CLIENT is told', async t => {
	const svc = await load(t);
	await svc.createForRequest('p1', 'prov-1', 'provider', { reason: 'سبب كافٍ للنزاع', description: 'وصف كافٍ للنزاع هنا' });
	assert.equal(sent[0].userId, 'client-1');
	assert.match(sent[0].title, /فتح نزاع على مشروعك/);
});

test('admin resolves: the client (the party that is not the provider) gets the outcome', async t => {
	const svc = await load(t);
	await svc.resolve('d1', 'admin-1', { action: 'resolve', resolution: 'استرداد جزئي' });
	assert.equal(sent[0].userId, 'client-1');
	assert.equal(sent[0].type, 'DISPUTE_RESOLVED');
	assert.match(sent[0].message, /استرداد جزئي/);
});

test('admin rejects a dispute the provider opened: still the client who is told, not the provider', async t => {
	const svc = await load(t, { disputeFor: { id: 'd1', requestId: null, projectId: 'p1', openedById: 'prov-1', againstUserId: 'client-1', status: 'UNDER_REVIEW' } });
	await svc.resolve('d1', 'admin-1', { action: 'reject' });
	assert.equal(sent[0].userId, 'client-1');
	assert.match(sent[0].title, /دون قبوله/);
});
