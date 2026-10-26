import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// GET /provider/offers: `contract` carries the real contract values ONLY for the offer the provider can sign right now
// (offer PENDING_SIGNATURE + contract waiting for the provider + escrow HELD). Every other offer gets contract:null.

const base = (over: Record<string, unknown> = {}) => ({
	id: 'offer-1', projectId: 'proj-1', title: 'عرض', totalPrice: 1000, deliveryDays: 14, createdAt: new Date('2026-10-01T00:00:00Z'), status: 'PENDING_SIGNATURE',
	milestones: [{ id: 'm1' }, { id: 'm2' }],
	project: {
		id: 'proj-1', title: 'تصميم هوية', client: { id: 'c1', firstName: 'سارة', lastName: 'علي', accountType: 'CLIENT_INDIVIDUAL', avatarUrl: null },
		contract: { id: 'ctr-1', status: 'PENDING_PROVIDER_SIGNATURE', termsVersion: 1, price: 950, durationDays: 12, phasesCount: 2, terms: { milestones: [{ stepOrder: 1, title: 'مسودة', days: 5, percentage: 40, amount: 380 }, { stepOrder: 2, title: 'نهائي', days: 7, percentage: 60, amount: 570 }] } },
		escrow: { amount: 950, status: 'HELD' }
	},
	...over
});

async function offersFor(t: TestContext, proposals: any[]) {
	const prismaMock = { projectProposal: { groupBy: async () => [], count: async () => proposals.length, findMany: async () => proposals } };
	t.mock.module('../utils/prisma.client', { namedExports: { prisma: prismaMock } });
	t.mock.module('./ai-proposal.service', { namedExports: { aiProposalService: {} } });
	t.mock.module('../socket', { namedExports: { getIO: () => ({}) } });
	const { proposalService } = await import(`./proposal.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return (await proposalService.getProviderOffers('provider-1', {})).data as any[];
}

test('an offer the provider can sign carries the real contract: price, duration, phases, saved milestones, funded escrow', async (t) => {
	const [o] = await offersFor(t, [base()]);
	assert.equal(o.status, 'PENDING_SIGNATURE');
	assert.deepEqual({ ...o.contract, milestones: o.contract.milestones.map((m: any) => [m.order, m.title, m.days, m.percentage, m.amount]) }, {
		id: 'ctr-1', status: 'PENDING_PROVIDER_SIGNATURE', termsVersion: 1, price: 950, currency: 'USD', durationDays: 12, phasesCount: 2,
		milestones: [[1, 'مسودة', 5, 40, 380], [2, 'نهائي', 7, 60, 570]], escrow: { amount: 950, status: 'HELD' }, providerTerms: null // no frozen rate on this fixture's escrow
	});
});

test('terms that are garbage never break the response: real price/duration/phases, empty milestones', async (t) => {
	const garbage = base();
	garbage.project.contract.terms = '{not json' as any;
	const [o] = await offersFor(t, [garbage]);
	assert.equal(o.contract.price, 950);
	assert.equal(o.contract.durationDays, 12);
	assert.equal(o.contract.phasesCount, 2);
	assert.deepEqual(o.contract.milestones, []);
});

test('no contract for offers the provider cannot sign yet or that are not at the signing stage', async (t) => {
	const clientNotSigned = base(); clientNotSigned.project.contract.status = 'PENDING_CLIENT_SIGNATURE';
	const noEscrow = base({ id: 'offer-2' }); (noEscrow.project as any).escrow = null;
	const escrowNotHeld = base({ id: 'offer-3' }); escrowNotHeld.project.escrow.status = 'RELEASED';
	const noContractRow = base({ id: 'offer-4' }); (noContractRow.project as any).contract = null;
	const submitted = base({ id: 'offer-5', status: 'SUBMITTED' });
	const negotiating = base({ id: 'offer-6', status: 'UNDER_NEGOTIATION' });
	const accepted = base({ id: 'offer-7', status: 'ACCEPTED' });
	const rejected = base({ id: 'offer-8', status: 'REJECTED' });
	const out = await offersFor(t, [clientNotSigned, noEscrow, escrowNotHeld, noContractRow, submitted, negotiating, accepted, rejected]);
	assert.equal(out.length, 8);
	for (const o of out) assert.equal(o.contract, null, `${o.id} (${o.status})`);
	assert.equal(out[0].status, 'PENDING_CLIENT_SIGNATURE');
});

test('every offer item carries its REAL project id (not the offer id), so messaging can open this project\'s conversation', async (t) => {
	const a = base({ id: 'offer-A', projectId: 'proj-A' }); a.project.id = 'proj-A';
	const b = base({ id: 'offer-B', projectId: 'proj-B', status: 'SUBMITTED' }); b.project.id = 'proj-B';
	const out = await offersFor(t, [a, b]);
	assert.deepEqual(out.map((o: any) => [o.offerId, o.projectId]), [['offer-A', 'proj-A'], ['offer-B', 'proj-B']]);
	for (const o of out) assert.notEqual(o.projectId, o.offerId);
});

// GET /provider/offers/:id: same item shape as the list, own offers only (someone else's = 404).
test('getProviderOfferById returns the list item shape for an offer beyond the first page, scoped to the provider', async (t) => {
	let where: any;
	const prismaMock = { projectProposal: { findFirst: async (a: any) => { where = a.where; return a.where.providerId === 'provider-1' && a.where.id === 'offer-99' ? base({ id: 'offer-99' }) : null; } } };
	t.mock.module('../utils/prisma.client', { namedExports: { prisma: prismaMock } });
	t.mock.module('./ai-proposal.service', { namedExports: { aiProposalService: {} } });
	t.mock.module('../socket', { namedExports: { getIO: () => ({}) } });
	const { proposalService } = await import(`./proposal.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const o = await proposalService.getProviderOfferById('provider-1', 'offer-99');
	assert.equal(o.id, 'offer-99');
	assert.equal(o.projectId, 'proj-1');
	assert.equal(o.contract.price, 950);
	assert.deepEqual(where, { id: 'offer-99', providerId: 'provider-1' });
	await assert.rejects(() => proposalService.getProviderOfferById('provider-2', 'offer-99'), (e: any) => e.statusCode === 404);
});
