import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';

/**
 * REAL PostgreSQL test of contract funding idempotency (isolated throw-away DB only, synthetic data):
 * a double submit / second tab with the same signing code must debit the wallet and lock the escrow exactly ONCE, the losers get a clean 409,
 * and a later refresh/retry never charges again. Same guard as pg-concurrency.pg.test.ts (QA_ISOLATED_PG_URL == DATABASE_URL, 127.0.0.1:55432).
 * Mail goes to a closed local port (never to a real SMTP server).
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
if (enabled) { process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = '1'; process.env.OTP_SECRET ||= 'pg-test-otp'; }
const id = () => randomUUID();

async function seed() {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const mk = (type: any, role: any, n: string, wallet = 0) => prisma.user.create({ data: { id: id(), accountType: type, status: 'ACTIVE', firstName: n, lastName: 'QA', email: `qa-${n}-${tag}@pg.test`, walletBalance: wallet, roles: [role], activeRole: role } });
	const client = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'client', 100);
	const provider = await mk('PROVIDER_INDIVIDUAL', 'PROVIDER', 'prov');
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'QA' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'QA' } });
	const profile = await prisma.clientProfile.create({ data: { id: id(), userId: client.id } as any });
	const req = await prisma.clientRequest.create({ data: { id: id(), clientProfileId: profile.id, specialtyId: spec.id, title: `QA ${tag}`, description: 'synthetic description text', status: 'OPEN' } as any });
	await prisma.project.create({ data: { id: req.id, title: `QA ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, status: 'OPEN' } as any });
	const pp = await prisma.projectProposal.create({ data: { id: id(), projectId: req.id, providerId: provider.id, title: 'offer', message: 'scope text', outputs: 'deliverables', advantages: ['a'], totalPrice: 40, deliveryDays: 10, status: 'SUBMITTED', milestones: { create: [{ stepOrder: 1, title: 'S1', description: 'd', days: 5, percentage: 50, amount: 20 }, { stepOrder: 2, title: 'S2', description: 'd', days: 5, percentage: 50, amount: 20 }] } } as any });
	const legacy = await prisma.proposal.create({ data: { id: id(), clientRequestId: req.id, providerId: provider.id, price: 40, deliveryDays: 10, status: 'SUBMITTED' } as any });
	return { prisma, client, provider, req, pp, legacy };
}
const otp = async (w: Awaited<ReturnType<typeof seed>>, contractId: string, code: string) => w.prisma.otpVerification.create({ data: { userId: w.client.id, type: 'EMAIL', code: createHmac('sha256', process.env.OTP_SECRET!).update(`${contractId}:${code}`).digest('hex'), context: { purpose: 'CLIENT_CONTRACT_SIGNATURE', requestId: w.req.id, contractId }, expiresAt: new Date(Date.now() + 600_000) } });
const status = (e: any) => e?.statusCode ?? e?.status;

test('pg: the contract read returns the frozen offer terms; selecting freezes price/stages once', opts, async () => {
	const w = await seed();
	const { clientRequestsService: svc } = await import('./client-requests.service');
	await svc.selectOffer(w.client.id, w.req.id, w.legacy.id);
	await svc.selectOffer(w.client.id, w.req.id, w.legacy.id); // select twice: same single contract
	assert.equal(await w.prisma.contract.count({ where: { projectId: w.req.id } }), 1);
	const c: any = await svc.getContractForSignature(w.client.id, w.req.id, w.legacy.id);
	assert.equal(c.ready, true); assert.equal(c.price, 40); assert.equal(c.milestones.length, 2);
	assert.deepEqual(c.offerTerms, { summary: 'scope text', deliverables: 'deliverables', advantages: ['a'] });
	assert.equal('discount' in c || 'aiCheck' in c, false);
	await assert.rejects(() => svc.getContractForSignature(randomUUID(), w.req.id), (e: any) => status(e) === 404);
});

test('pg: 5 simultaneous deposits with the same code (double submit / second tab) debit once; losers get a clean 409; a retry never charges again (10 rounds)', opts, async () => {
	const { clientRequestsService: svc } = await import('./client-requests.service');
	for (let round = 0; round < 10; round++) {
		const w = await seed();
		await svc.selectOffer(w.client.id, w.req.id, w.legacy.id);
		const contract = (await w.prisma.contract.findUnique({ where: { projectId: w.req.id } }))!;
		await otp(w, contract.id, '123456');
		const res = await Promise.allSettled(Array.from({ length: 5 }, () => svc.depositEscrow(w.client.id, w.req.id, w.legacy.id, '123456', 'wallet')));
		const ok = res.filter(r => r.status === 'fulfilled').length;
		const codes = res.filter(r => r.status === 'rejected').map(r => status((r as any).reason));
		assert.equal(ok, 1, `round ${round}: ${codes}`);
		assert.ok(codes.every(c => c === 409 || c === 400), `round ${round}: losers must be clean 400/409, got ${codes}`);
		assert.equal(Number((await w.prisma.user.findUnique({ where: { id: w.client.id } }))!.walletBalance), 60, 'debited exactly once (100 - 40)');
		assert.equal(await w.prisma.walletTransaction.count({ where: { userId: w.client.id, type: 'ESCROW_LOCK' } }), 1);
		const esc = await w.prisma.escrow.findUnique({ where: { projectId: w.req.id } });
		assert.equal(esc!.status, 'HELD'); assert.equal(esc!.amount, 40);
		// refresh / retry later (even with a fresh code): refused, never a second payment
		await otp(w, contract.id, '654321');
		await assert.rejects(() => svc.depositEscrow(w.client.id, w.req.id, w.legacy.id, '654321', 'wallet'), (e: any) => status(e) === 409);
		assert.equal(Number((await w.prisma.user.findUnique({ where: { id: w.client.id } }))!.walletBalance), 60);
		await assert.rejects(() => svc.selectOffer(w.client.id, w.req.id, w.legacy.id), (e: any) => status(e) === 409);
	}
});

test('pg: insufficient wallet -> 402, nothing debited, contract stays signable', opts, async () => {
	const { clientRequestsService: svc } = await import('./client-requests.service');
	const w = await seed();
	await w.prisma.user.update({ where: { id: w.client.id }, data: { walletBalance: 10 } });
	await svc.selectOffer(w.client.id, w.req.id, w.legacy.id);
	const contract = (await w.prisma.contract.findUnique({ where: { projectId: w.req.id } }))!;
	await otp(w, contract.id, '111111');
	await assert.rejects(() => svc.depositEscrow(w.client.id, w.req.id, w.legacy.id, '111111', 'wallet'), (e: any) => status(e) === 402);
	assert.equal(Number((await w.prisma.user.findUnique({ where: { id: w.client.id } }))!.walletBalance), 10);
	assert.equal((await w.prisma.contract.findUnique({ where: { projectId: w.req.id } }))!.status, 'PENDING_CLIENT_SIGNATURE');
	assert.equal(await w.prisma.escrow.count({ where: { projectId: w.req.id } }), 0);
});
