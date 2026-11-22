import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Direct legal-name saves keep legacy requests from overwriting newer owner data.
function setup(t: TestContext, over: { pending?: boolean; legalName?: string | null; kyc?: string } = {}) {
	const updates: any[] = [], creates: any[] = [], audits: any[] = [], triggers: any[] = [];
	const state = { pending: over.pending ?? true, legalName: over.legalName === undefined ? 'عمرو محمود' : over.legalName, kyc: over.kyc ?? 'PENDING' };
	const tx: any = {
		$queryRaw: async () => [], $executeRaw: async () => 0,
		user: { findUnique: async () => ({ legalName: state.legalName }), update: async (a: any) => { state.legalName = a.data.legalName; return {}; } },
		clientProfile: { findUnique: async () => ({ kycStatus: state.kyc }), update: async (a: any) => { updates.push(a); state.kyc = a.data.kycStatus; return {}; } },
		providerProfile: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
		profileModificationRequest: {
			findFirst: async () => state.pending ? { id: 'req-old', requestedValue: 'اسم سابق معلق', createdAt: new Date() } : null,
			updateMany: async (a: any) => { updates.push(a); const count = state.pending ? 1 : 0; state.pending = false; return { count }; },
			create: async (a: any) => { creates.push(a); return { id: 'unexpected-new-request' }; },
		},
	};
	const prismaMock: any = { ...tx, $transaction: async (fn: any) => fn(tx) };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async (a: any) => audits.push(a) } } });
	t.mock.module('./identity-field-check.service', { namedExports: { identityFieldCheckService: { triggerSafe: (...a: any[]) => triggers.push(a) } } });
	t.mock.module('./identity-gate.service', { namedExports: { identityGateService: { refreshClientReview: async () => undefined } } });
	t.mock.module('./identity-claim.service', { namedExports: { identityClaimService: { release: async () => undefined } } });
	return { updates, creates, audits, state, triggers };
}
const load = async () => (await import(`./legal-name.service.ts?fixture=${Date.now()}-${Math.random()}`)).legalNameService;

for (const kyc of ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED']) test(`legal name saves immediately for ${kyc}; old pending request is cancelled, no new request`, async t => {
	const { updates, creates, state, triggers, audits } = setup(t, { kyc });
	const svc = await load(); const r = await svc.set('u1', 'عمرو محمود يحيى', {});
	assert.equal(r.outcome, 'SAVED'); assert.equal(r.view.legalName, 'عمرو محمود يحيى');
	assert.equal(r.view.changeNeedsReview, false); assert.equal(r.view.pendingRequest, null);
	assert.equal(creates.length, 0); assert.equal(state.pending, false);
	assert.equal(updates[0].where.providerId, 'u1'); assert.equal(updates[0].where.category, 'LEGAL_NAME_CHANGE'); assert.equal(updates[0].where.status, 'PENDING_HUMAN_REVIEW');
	assert.deepEqual(updates[0].data, { status: 'CANCELLED' });
	assert.deepEqual(triggers, [['u1', 'CLIENT']]); assert.equal(audits[0].eventType, 'LEGAL_NAME_SAVED');
});
test('saving the current name also cancels an obsolete pending request without changing the identity', async t => {
	const { state, creates, triggers } = setup(t, { kyc: 'VERIFIED' }); const svc = await load();
	const r = await svc.set('u1', 'عمرو محمود');
	assert.equal(r.outcome, 'UNCHANGED'); assert.equal(r.view.pendingRequest, null); assert.equal(state.kyc, 'VERIFIED');
	assert.equal(creates.length, 0); assert.equal(triggers.length, 0);
});
test('invalid names do not cancel requests or write anything', async t => {
	const { state, updates, creates } = setup(t); const svc = await load();
	await assert.rejects(svc.set('u1', 'عمرو'), (e: any) => e.code === 'LEGAL_NAME_NEEDS_TWO_PARTS');
	assert.equal(state.pending, true); assert.equal(updates.length, 0); assert.equal(creates.length, 0);
});
test('legacy cancellation endpoint remains compatible for older clients', async t => {
	const { state } = setup(t); const svc = await load();
	assert.equal((await svc.cancelPending('u1')).view.pendingRequest, null); assert.equal(state.pending, false);
	await assert.rejects(svc.cancelPending('u1'), (e: any) => e.statusCode === 404);
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
