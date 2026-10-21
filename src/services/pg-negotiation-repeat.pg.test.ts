import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432). A negotiation request (client -> provider offer) sent several times at once / again after a lost answer is stored and notified ONCE; a different request is a new one.
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

test('PG: the same negotiation request sent 3 times at once and again later is ONE card + ONE provider notification; a different request is a second card', opts, async () => {
	const { prisma, client, provider, spec } = await world();
	const { clientRequestsService } = await import('./client-requests.service');
	const { proposalService } = await import('./proposal.service');
	const { chatService } = await import('./chat.service');
	const req: any = await clientRequestsService.createRequest(client.id, dto(spec.id, 'طلب لتفاوض متكرر'));
	const offer: any = await proposalService.createProposal(req.id, provider.id, payload());
	const card = (price: string) => ({ isNegotiation: true, negType: 'price', negTypeName: 'السعر', price, duration: '', notes: 'خصم؟', status: 'PENDING' });
	const call = (price: string) => chatService.initiateConversation(client.id, { projectId: req.id, providerId: provider.id, offerId: offer.id, negotiationPayload: card(price) } as any);
	const res: any[] = await Promise.all([1, 2, 3].map(() => call('80')));
	assert.equal(new Set(res.map(r => r.id)).size, 1, 'one conversation');
	const cards = () => prisma.message.count({ where: { conversationId: res[0].id, content: { startsWith: 'WS_NEGOTIATION::' } } });
	assert.equal(await cards(), 1);
	await call('80');
	assert.equal(await cards(), 1, 'a later identical repeat adds nothing');
	await call('70');
	assert.equal(await cards(), 2, 'a different request is a new card');
	const notes = await prisma.notification.count({ where: { userId: provider.id, type: { contains: 'NEGOT' } } });
	assert.ok(notes <= 2, `provider notified at most once per distinct request (got ${notes})`);
});

test('PG: after the 5-minute window the identical negotiation card is stored again (limited rule)', opts, async () => {
	const { prisma, client, provider, spec } = await world();
	const { clientRequestsService } = await import('./client-requests.service');
	const { proposalService } = await import('./proposal.service');
	const { chatService } = await import('./chat.service');
	const req: any = await clientRequestsService.createRequest(client.id, dto(spec.id, 'طلب لانتهاء مدة التفاوض'));
	const offer: any = await proposalService.createProposal(req.id, provider.id, payload());
	const card = { isNegotiation: true, negType: 'price', negTypeName: 'السعر', price: '80', duration: '', notes: 'خصم؟', status: 'PENDING' };
	const call = () => chatService.initiateConversation(client.id, { projectId: req.id, providerId: provider.id, offerId: offer.id, negotiationPayload: card } as any);
	const conv: any = await call();
	await prisma.message.updateMany({ where: { conversationId: conv.id, content: { startsWith: 'WS_NEGOTIATION::' } }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) } });
	await call();
	assert.equal(await prisma.message.count({ where: { conversationId: conv.id, content: { startsWith: 'WS_NEGOTIATION::' } } }), 2);
});
