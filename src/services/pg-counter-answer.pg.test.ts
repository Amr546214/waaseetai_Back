import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432). Client accepts / declines the provider's counter offer on REAL rows (no dev data touched): success, double / concurrent accept, stale counter, withdrawn offer, inconsistent mirror (nothing half-written).
 * The AI evaluation is not configured here (it degrades to null fields, as in production when the AI is down). The lock is in-process (ONE Node process); the unique
 * (projectId, providerId) is the cross-instance backstop.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud';
process.env.CLOUDINARY_API_KEY ??= '123456789012345';
process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
const id = () => randomUUID();

async function world() {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const mk = (n: string, accountType: string, role: string) => prisma.user.create({ data: { id: id(), accountType: accountType as any, firstName: n, lastName: tag, email: `${n}-${tag}@pg.test`, roles: [role] as any, activeRole: role as any } });
	const client = await mk('client', 'CLIENT_INDIVIDUAL', 'CLIENT');
	const provider = await mk('prov', 'PROVIDER_INDIVIDUAL', 'PROVIDER');
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const profile = await prisma.clientProfile.create({ data: { id: id(), userId: client.id } as any });
	return { prisma, client, provider, spec, profile, tag };
}
const dto = (specialtyId: string, title: string) => ({ title, description: 'وصف تفصيلي كافٍ للطلب لاختبار منع التكرار', specialtyId, budgetType: 'FIXED', minBudget: 100, maxBudget: 200, expectedDurationDays: 7 } as any);
const MILESTONES = [{ stepOrder: 1, title: 'مرحلة أولى', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 100, amount: 1000 }];
const payload = () => ({ title: 'عرض تجريبي احترافي', message: 'وصف تفصيلي لعرضي يوضح خبرتي ومنهجيتي في العمل على هذا المشروع بشكل كامل.', advantages: [], outputs: '', portfolioIds: [], totalPrice: 1000, deliveryDays: 5, milestones: MILESTONES, agreedToTerms: true, agreedToEscrow: true } as any);

async function negotiated(price = '80') {
	const w = await world();
	const { clientRequestsService } = await import('./client-requests.service');
	const { proposalService } = await import('./proposal.service');
	const { chatService } = await import('./chat.service');
	const { providerOfferNegotiationService } = await import('./provider-offer-negotiation.service');
	const req: any = await clientRequestsService.createRequest(w.client.id, dto(w.spec.id, 'طلب عرض مضاد ' + w.tag));
	const offer: any = await proposalService.createProposal(req.id, w.provider.id, payload());
	const ask = (p: string, notes = 'خصم؟') => chatService.initiateConversation(w.client.id, { projectId: req.id, providerId: w.provider.id, offerId: offer.id, negotiationPayload: { isNegotiation: true, negType: 'price', negTypeName: 'السعر', price: p, duration: '', notes, status: 'PENDING' } } as any);
	await ask(price);
	const counter = async (p: number, d: number) => {
		await providerOfferNegotiationService.counter(w.provider.id, offer.id, { price: p, deliveryDays: d });
		const m = await w.prisma.message.findFirst({ where: { senderId: w.provider.id, content: { startsWith: 'WS_NEGOTIATION::' } }, orderBy: { createdAt: 'desc' } });
		return m!.id;
	};
	const state = async () => {
		const o = await w.prisma.projectProposal.findUnique({ where: { id: offer.id }, include: { milestones: true } });
		const mirror = await w.prisma.proposal.findFirst({ where: { clientRequestId: req.id, providerId: w.provider.id } });
		return { price: o!.totalPrice, days: o!.deliveryDays, status: String(o!.status), msum: o!.milestones.reduce((a, m) => a + m.amount, 0), mirrorPrice: mirror!.price, mirrorStatus: String(mirror!.status) };
	};
	return { ...w, req, offer, ask, counter, state, providerOfferNegotiationService };
}
const answers = async () => (await import('./client-offer-counter.service')).clientOfferCounterService;

test('PG: accepting the counter updates price, days, milestone amounts and the legacy mirror together and returns the offer to SUBMITTED', opts, async () => {
	const n = await negotiated(); const svc = await answers();
	const before = await n.state(); assert.equal(before.status, 'UNDER_NEGOTIATION');
	const cid = await n.counter(90, 4);
	await svc.accept(n.client.id, n.req.id, n.offer.id, { messageId: cid });
	const after = await n.state();
	assert.deepEqual({ price: after.price, days: after.days, status: after.status, mirrorPrice: after.mirrorPrice, mirrorStatus: after.mirrorStatus }, { price: 90, days: 4, status: 'SUBMITTED', mirrorPrice: 90, mirrorStatus: 'SUBMITTED' });
	assert.equal(Math.round(after.msum * 100) / 100, 90, 'milestone amounts re-split to EXACTLY the new price');
});

test('PG: a second accept, 3 concurrent accepts and an accept after a decline are refused 409 OFFER_STATE_CHANGED; the offer changes once and a refusal never half-writes', opts, async () => {
	const n = await negotiated(); const svc = await answers();
	const cid = await n.counter(90, 4);
	const res: any[] = await Promise.all([1, 2, 3].map(() => svc.accept(n.client.id, n.req.id, n.offer.id, { messageId: cid }).catch((e: any) => e)));
	assert.equal(res.filter(r => !(r instanceof Error)).length, 1);
	assert.ok(res.filter(r => r instanceof Error).every((e: any) => e.statusCode === 409));
	assert.equal((await n.state()).price, 90);
	const again: any = await svc.accept(n.client.id, n.req.id, n.offer.id, { messageId: cid }).catch((e: any) => e);
	assert.equal(again.statusCode, 409); assert.equal(again.code, 'OFFER_STATE_CHANGED');
	const m = await negotiated(); const cid2 = await m.counter(70, 3);
	await svc.decline(m.client.id, m.req.id, m.offer.id, { messageId: cid2 });
	const afterDecline = await m.state();
	const late: any = await svc.accept(m.client.id, m.req.id, m.offer.id, { messageId: cid2 }).catch((e: any) => e);
	assert.equal(late.statusCode, 409);
	assert.deepEqual(await m.state(), afterDecline, 'accept after decline changed nothing');
	assert.equal(afterDecline.price, 1000, 'decline keeps the original terms');
});

test('PG: a stale counter id (a newer counter exists) and a withdrawn offer are refused 409 and change nothing', opts, async () => {
	const n = await negotiated(); const svc = await answers();
	const old = await n.counter(90, 4);
	await n.ask('60', 'أقل؟'); // a new round: the client asks again, the provider counters again
	const newer = await n.counter(85, 4);
	const stale: any = await svc.accept(n.client.id, n.req.id, n.offer.id, { messageId: old }).catch((e: any) => e);
	assert.equal(stale.statusCode, 409);
	assert.equal((await n.state()).price, 1000, 'the stale counter changed nothing');
	const again: any = await n.providerOfferNegotiationService.counter(n.provider.id, n.offer.id, { price: 80, deliveryDays: 4 }).catch((e: any) => e);
	assert.equal(again.code, 'COUNTER_PENDING_EXISTS', 'a second counter while one waits is refused');
	await n.providerOfferNegotiationService.withdraw(n.provider.id, n.offer.id);
	const gone: any = await svc.accept(n.client.id, n.req.id, n.offer.id, { messageId: newer }).catch((e: any) => e);
	assert.equal(gone.statusCode, 409);
	assert.equal((await n.state()).price, 1000);
});

test('PG: inconsistent legacy mirror -> refused 409 and NOTHING is half-written (offer price/status, messages)', opts, async () => {
	const n = await negotiated(); const svc = await answers();
	const cid = await n.counter(90, 4);
	await n.prisma.proposal.updateMany({ where: { clientRequestId: n.req.id }, data: { status: 'SUBMITTED' as any } });
	const msgs = () => n.prisma.message.count({ where: { content: { startsWith: 'WS_' } } });
	const m0 = await msgs();
	const e: any = await svc.accept(n.client.id, n.req.id, n.offer.id, { messageId: cid }).catch((x: any) => x);
	assert.equal(e.statusCode, 409);
	const s = await n.state();
	assert.equal(s.price, 1000); assert.equal(s.status, 'UNDER_NEGOTIATION');
	assert.equal(await msgs(), m0, 'no reply message was written');
});
