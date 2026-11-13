import { randomUUID as id } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { writeFileSync } from 'node:fs';
const BE = '/Users/amrokasha/Desktop/Waseet-Audit/wta/nb-be/src';
(async () => {
	const { prisma } = await import(`${BE}/config/db`);
	const tag = id().slice(0, 6); const secret = 'live-test-secret';
	const mkUser = (type: string, role: string, n: string, extra: any = {}) => prisma.user.create({ data: { id: id(), accountType: type as any, status: 'ACTIVE', firstName: n, lastName: 'Live', email: `live-${n}-${tag}@pg.test`, roles: [role] as any, activeRole: role as any, walletBalance: 0, ...extra } });
	const client = await mkUser('CLIENT_INDIVIDUAL', 'CLIENT', 'client', { walletBalance: 500 });
	const provider = await mkUser('PROVIDER_INDIVIDUAL', 'PROVIDER', 'prov', { walletBalance: 120 });
	const sa = await mkUser('SUPER_ADMIN', 'SUPER_ADMIN', 'sa');
	const sa2 = await mkUser('SUPER_ADMIN', 'SUPER_ADMIN', 'sa2');
	const role = await prisma.adminRole.create({ data: { id: id(), name: 'QA-ROLE-FINANCE', nameKey: 'qa-role-finance-' + tag, description: 'دور اختبار', permissions: [], createdById: sa.id } });
	const members: any[] = [];
	for (const n of ['staffa', 'staffb']) { const u = await mkUser('ADMIN', 'ADMIN', n); await prisma.adminStaff.create({ data: { id: id(), userId: u.id, roleId: role.id, title: 'محاسب ' + n } }); members.push(u); }
	const susp = await mkUser('CLIENT_INDIVIDUAL', 'CLIENT', 'suspended', { status: 'SUSPENDED' });
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } }); const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const profile = await prisma.clientProfile.create({ data: { id: id(), userId: client.id, firstName: 'Live', lastName: 'Client', kycStatus: 'APPROVED' } as any }).catch(async () => prisma.clientProfile.create({ data: { id: id(), userId: client.id } as any }));
	await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, isProfileSetupComplete: true, setupTestStatus: 'COMPLETED' } as any }).catch(() => null);
	const mk = async (title: string, o: { contract: string; escrow: string; released: number; v2: boolean }) => {
		const rid = id();
		await prisma.clientRequest.create({ data: { id: rid, clientProfileId: profile.id, specialtyId: spec.id, title, description: 'وصف تجريبي كافٍ للطلب', subSpecialties: [], requiredSkills: [], status: 'IN_PROGRESS' } });
		await prisma.project.create({ data: { id: rid, title, description: 'x', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
		const offer = await prisma.projectProposal.create({ data: { id: id(), projectId: rid, providerId: provider.id, title: 'عرض', message: 'm', totalPrice: 20, deliveryDays: 4, status: 'ACCEPTED' } });
		await prisma.proposal.create({ data: { id: id(), projectId: rid, clientRequestId: rid, providerId: provider.id, price: 20, deliveryDays: 4, status: 'ACCEPTED' } });
		const contract = await prisma.contract.create({ data: { id: id(), projectId: rid, clientId: client.id, providerId: provider.id, offerId: offer.id, price: 20, durationDays: 14, phasesCount: 2, status: o.contract as any, signedAt: new Date() } });
		const r = o.released; const comm = Math.round(r * 12.75) / 100;
		const escrow = await prisma.escrow.create({ data: { id: id(), projectId: rid, amount: 20, status: o.escrow as any, releasedAmount: r, fundedAt: new Date(), ...(o.v2 ? { feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, platformCommissionAmount: comm, providerNetReleasedAmount: r - comm } : {}) } });
		await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'المرحلة الأولى', days: 7, percentage: 50, amount: 10, status: r ? 'APPROVED' : 'IN_PROGRESS', approvedAt: r ? new Date() : null } });
		await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 2, title: 'المرحلة الثانية', days: 7, percentage: 50, amount: 10, status: 'PENDING' } });
		return { requestId: rid, contractId: contract.id, escrowId: escrow.id, title };
	};
	const A = await mk('QA-ADMIN-RELEASE', { contract: 'ACTIVE', escrow: 'HELD', released: 0, v2: false });
	const B = await mk('QA-RELEASE-NET', { contract: 'ACTIVE', escrow: 'HELD', released: 10, v2: true });
	const C = await mk('QA-SUSPEND-LINKED', { contract: 'ACTIVE', escrow: 'HELD', released: 0, v2: true });
	const D = await mk('QA-CANCEL-FUNDED-REQ', { contract: 'ACTIVE', escrow: 'HELD', released: 0, v2: true });
	const E = await mk('QA-CANCEL-FUNDED-CONTRACT', { contract: 'ACTIVE', escrow: 'HELD', released: 0, v2: true });
	for (const [t, a, d] of [['DEPOSIT', 200, 'إيداع في المحفظة'], ['ESCROW_LOCK', -20, 'حجز ضمان QA'], ['ESCROW_RELEASE', 17.45, 'صرف مرحلة (صافي بعد العمولة)']] as any)
		await prisma.walletTransaction.create({ data: { id: id(), userId: t === 'ESCROW_RELEASE' ? provider.id : client.id, type: t, amount: a, currency: 'USD', status: 'COMPLETED', description: d, referenceId: 'live-' + tag + '-' + t } });
	const tok = (u: any) => jwt.sign({ userId: u.id, accountType: u.accountType, activeRole: u.activeRole, roles: u.roles }, secret, { expiresIn: '6h' });
	const uj = (u: any) => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, accountType: u.accountType, activeRole: u.activeRole, roles: u.roles, status: u.status });
	writeFileSync(process.argv[2], JSON.stringify({ tag, client: { token: tok(client), user: uj(client), id: client.id }, provider: { token: tok(provider), user: uj(provider), id: provider.id }, admin: { token: tok(sa), user: uj(sa), id: sa.id }, admin2: { id: sa2.id, email: sa2.email }, roleName: role.name, members: members.map(m => m.email), susp: { id: susp.id, email: susp.email }, A, B, C, D, E }, null, 1));
	await prisma.$disconnect();
})();
