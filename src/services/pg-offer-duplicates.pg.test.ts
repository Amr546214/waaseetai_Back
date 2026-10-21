import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432). A provider's offer sent several times at once -> ONE offer, the others 409 PROPOSAL_ALREADY_SUBMITTED, counters moved once.
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

test('PG: the same offer sent 5 times at once is ONE offer; the rest are 409 PROPOSAL_ALREADY_SUBMITTED and the counters moved once', opts, async () => {
	const { prisma, client, provider, spec } = await world();
	const { clientRequestsService } = await import('./client-requests.service');
	const { proposalService } = await import('./proposal.service');
	const req: any = await clientRequestsService.createRequest(client.id, dto(spec.id, 'طلب لعروض متزامنة'));
	const res: any[] = await Promise.all([1, 2, 3, 4, 5].map(() => proposalService.createProposal(req.id, provider.id, payload()).catch((e: any) => e)));
	assert.equal(res.filter(r => r?.id && !(r instanceof Error)).length, 1);
	const refused = res.filter(r => r instanceof Error);
	assert.equal(refused.length, 4);
	assert.ok(refused.every((e: any) => e.code === 'PROPOSAL_ALREADY_SUBMITTED' && e.statusCode === 409));
	assert.equal(await prisma.projectProposal.count({ where: { projectId: req.id, providerId: provider.id } }), 1);
	assert.equal(await prisma.proposal.count({ where: { clientRequestId: req.id, providerId: provider.id } }), 1);
	assert.equal((await prisma.clientRequest.findUnique({ where: { id: req.id } }))!.proposalsCount, 1);
	assert.equal(await prisma.notification.count({ where: { userId: client.id, type: { contains: 'OFFER' } } }) <= 1, true);
});
