import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// A mistaken legal-name request must be fixable: a new request replaces the waiting one, the owner can withdraw it, and it shows up in the client's «طلبات تعديل الملف» list.

function setup(t: TestContext, over: { pending?: { id: string } | null; legalName?: string | null; kyc?: string | null } = {}) {
	const updates: any[] = []; const creates: any[] = []; const audits: any[] = [];
	const state = { pending: over.pending === undefined ? { id: 'req-old' } : over.pending };
	const tx: any = {
		$queryRaw: async () => [], $executeRaw: async () => 0,
		user: { findUnique: async () => ({ legalName: over.legalName === undefined ? 'عمرو محمود' : over.legalName }), update: async () => ({}) },
		clientProfile: { findUnique: async () => (over.kyc === null ? null : { kycStatus: over.kyc ?? 'PENDING' }) },
		providerProfile: { findUnique: async () => null },
		profileModificationRequest: {
			findFirst: async () => state.pending,
			updateMany: async (a: any) => { updates.push(a); if (a.where.id === 'req-old' || a.where.category) { const had = !!state.pending; state.pending = null; return { count: had ? 1 : 0 }; } return { count: 0 }; },
			create: async (a: any) => { creates.push(a); state.pending = { id: 'req-new' }; return { id: 'req-new' }; },
		},
	};
	const prismaMock: any = { ...tx, $transaction: async (fn: any) => fn(tx),
		profileModificationRequest: { ...tx.profileModificationRequest, findFirst: async () => (state.pending ? { id: state.pending.id, requestedValue: 'x', createdAt: new Date() } : null) } };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async (a: any) => { audits.push(a); } } } });
	t.mock.module('./identity-field-check.service', { namedExports: { identityFieldCheckService: { triggerSafe: () => undefined } } });
	t.mock.module('./identity-gate.service', { namedExports: { identityGateService: {} } });
	t.mock.module('./identity-claim.service', { namedExports: { identityClaimService: {} } });
	return { updates, creates, audits, state };
}
const load = async () => (await import(`./legal-name.service.ts?fixture=${Date.now()}-${Math.random()}`)).legalNameService;

test('a new name request REPLACES the one still waiting: the old is withdrawn, the new is created, no 409', async t => {
	const { updates, creates, state } = setup(t);
	const svc = await load();
	const r = await svc.set('u1', 'عمرو محمود يحيى', {});
	assert.equal(r.outcome, 'REQUEST_CREATED');
	assert.deepEqual(updates[0].data, { status: 'CANCELLED' });
	assert.equal(updates[0].where.id, 'req-old');
	assert.equal(creates.length, 1);
	assert.equal(creates[0].data.requestedValue.includes('عمرو'), true);
	assert.equal(state.pending!.id, 'req-new');
});

test('the owner can withdraw the waiting name request; with nothing waiting it is a 404 and nothing is written', async t => {
	const a = setup(t);
	const svc = await load();
	const out = await svc.cancelPending('u1', {});
	assert.deepEqual(a.updates[0].data, { status: 'CANCELLED' });
	assert.equal(a.updates[0].where.status, 'PENDING_HUMAN_REVIEW');
	assert.equal(a.audits[0].eventType, 'LEGAL_NAME_REQUEST_CANCELLED');
	assert.equal(out.view.pendingRequest, null);
	await assert.rejects(svc.cancelPending('u1', {}), (e: any) => e.statusCode === 404);
});

test('the client request list and the withdraw action include the legal-name request category (and still only the owner\'s)', async t => {
	const calls: any[] = [];
	t.mock.module('../config/db', { namedExports: { prisma: { profileModificationRequest: {
		findMany: async (a: any) => { calls.push(['list', a]); return []; },
		updateMany: async (a: any) => { calls.push(['cancel', a]); return { count: 1 }; },
		findFirst: async () => null,
	} } } });
	const { profileService } = await import(`./profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
	await profileService.getMyChangeRequests('u1');
	await profileService.cancelMyChangeRequest('u1', 'r1');
	for (const [, a] of calls.slice(0, 2)) {
		assert.equal(a.where.providerId, 'u1');
		assert.deepEqual(a.where.OR, [{ category: { startsWith: 'CLIENT_' } }, { category: 'LEGAL_NAME_CHANGE' }]);
	}
	assert.equal(calls[1][1].where.status, 'PENDING_HUMAN_REVIEW');
});
