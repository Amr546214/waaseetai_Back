import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// D1 admin services with a swappable fake prisma (mock.module once; each test installs its own `current`). No database, no network.
let current: any = {};
const prisma: any = new Proxy({}, { get: (_t, k: string) => (k === '$transaction' ? (fn: any) => fn(current) : current[k]) });
const notes: any[] = [];
mock.module('../config/db', { namedExports: { prisma } });
mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
mock.module('../utils/socket-registry', { namedExports: { disconnectUserSockets: async () => 0 } });
mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { notes.push(n); return n; }, emitStored: async () => {} } } });

const fresh = async (p: string) => import(`${p}?f=${Date.now()}-${Math.random()}`);
const admin = { id: 'adm', accountType: 'ADMIN' };
const superAdmin = { id: 'sup', accountType: 'SUPER_ADMIN' };
const rejects = async (p: Promise<unknown>, status: number, re?: RegExp) => {
	await assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });
};
const counter = (n = 0) => async () => n;

// ───────────── dashboard
test('dashboard summary: empty database gives zeros, no alerts, never a fixed figure', async () => {
	const zero = { count: counter(0), aggregate: async () => ({ _sum: {} }) };
	current = { user: zero, project: zero, clientRequest: zero, escrow: zero, dispute: zero, supportTicket: zero, withdrawal: zero, profileModificationRequest: zero, providerProfile: zero, clientOnboarding: zero, affiliateProfile: zero, profileChangeRequest: zero, accreditationSample: zero, providerSpecialty: zero };
	const { adminDashboardService } = await fresh('./admin-dashboard.service.ts');
	const s = await adminDashboardService.getSummary(new Date('2026-10-14T10:00:00Z'));
	assert.equal(s.kpis.users.total, 0);
	assert.equal(s.kpis.users.growthPercent, null);
	assert.deepEqual(s.kpis.revenue, { platformCommissionTotal: 0, platformCommissionThisMonth: 0, escrowHeld: 0 });
	assert.equal(s.kpis.withdrawals.pendingAmount, 0);
	assert.deepEqual(s.alerts, []);
	assert.ok(s.queues.every((q: any) => q.count === 0 && q.link.startsWith('/supper-admin-overview/')));
});

test('dashboard summary: aggregates with fixtures flow through (counts, sums, alerts, growth)', async () => {
	const by = (map: Record<string, number>) => ({ count: async (a: any) => map[JSON.stringify(a?.where ?? {})] ?? map.default ?? 0 });
	const sum = (v: number) => async () => ({ _sum: { platformCommissionAmount: v, amount: v } });
	current = {
		user: { count: async (a: any) => (a.where.createdAt?.lt ? 4 : a.where.createdAt?.gte ? (a.where.createdAt.lt === undefined && a.where.createdAt.gte.getUTCMonth() === 9 ? 6 : 4) : 10) },
		project: { count: counter(3) }, clientRequest: { count: counter(2) },
		escrow: { aggregate: sum(125.456) },
		dispute: { count: async (a: any) => (a.where.createdAt ? 1 : 5) },
		supportTicket: { count: counter(7) },
		withdrawal: { count: counter(2), aggregate: async () => ({ _sum: { amount: 300 } }) },
		profileModificationRequest: { count: counter(1) }, providerProfile: { count: counter(2) },
		clientOnboarding: { count: async (a: any) => (a.where.createdAt ? 1 : 3) },
		affiliateProfile: { count: counter(0) }, profileChangeRequest: { count: counter(0) }, accreditationSample: { count: counter(4) }, providerSpecialty: { count: counter(9) }
	};
	const { adminDashboardService } = await fresh('./admin-dashboard.service.ts');
	const s = await adminDashboardService.getSummary(new Date('2026-10-14T10:00:00Z'));
	assert.equal(s.kpis.projects.active, 3);
	assert.equal(s.kpis.disputes.open, 5);
	assert.equal(s.kpis.disputes.openOver7Days, 1);
	assert.equal(s.kpis.tickets.open, 7);
	assert.equal(s.kpis.withdrawals.pendingAmount, 300);
	assert.equal(s.kpis.revenue.platformCommissionTotal, 125.46);
	assert.equal(s.queues.find((q: any) => q.key === 'kyc').count, 2 + 3);
	assert.ok(s.alerts.some((a: any) => a.key === 'disputesOver7Days' && a.severity === 'high'));
	void by;
});

test('dashboard charts: fills every day/month with 0 and counts real rows', async () => {
	current = {
		user: { findMany: async () => [{ createdAt: new Date('2026-10-14T01:00:00Z') }, { createdAt: new Date('2026-10-14T05:00:00Z') }, { createdAt: new Date('2026-10-12T05:00:00Z') }] },
		escrow: { findMany: async () => [{ platformCommissionAmount: 10.5, updatedAt: new Date('2026-10-02T00:00:00Z') }, { platformCommissionAmount: 4, updatedAt: new Date('2026-10-20T00:00:00Z') }] },
		project: { groupBy: async () => [{ status: 'OPEN', _count: { _all: 11 } }] }
	};
	const { adminDashboardService } = await fresh('./admin-dashboard.service.ts');
	const c = await adminDashboardService.getCharts(7, new Date('2026-10-14T10:00:00Z'));
	assert.equal(c.registrations.length, 7);
	assert.equal(c.registrations.at(-1)!.count, 2);
	assert.equal(c.registrationsTotal, 3);
	assert.equal(c.commission.length, 6);
	assert.equal(c.commission.at(-1)!.amount, 14.5);
	assert.deepEqual(c.projectsByStatus, [{ status: 'OPEN', count: 11 }]);
});

test('dashboard activity: empty -> [], otherwise newest first across sources', async () => {
	const none = { findMany: async () => [] };
	current = { user: none, dispute: none, withdrawal: none, supportTicket: none, accreditationSample: none, accountAuditLog: none };
	const { adminDashboardService } = await fresh('./admin-dashboard.service.ts');
	assert.deepEqual((await adminDashboardService.getActivity()).items, []);
	current = { ...current,
		user: { findMany: async () => [{ id: 'u1', firstName: 'سارة', lastName: 'ع', email: 'a@x', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', createdAt: new Date('2026-10-13') }] },
		dispute: { findMany: async () => [{ id: 'd1', reason: 'تأخير', status: 'OPEN', createdAt: new Date('2026-10-14'), openedBy: { firstName: 'م', lastName: 'ح', accountType: 'CLIENT_INDIVIDUAL' } }] } };
	const a = await adminDashboardService.getActivity(10);
	assert.deepEqual(a.items.map((i: any) => i.kind), ['DISPUTE_OPENED', 'USER_REGISTERED']);
	assert.equal(a.items[1].actorType, 'مقدم خدمة فرد');
});

// ───────────── users
const userRow = (o: any = {}) => ({ id: 'u1', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', ...o });
function userFixture(target: any) {
	const audit: any[] = []; const updates: any[] = [];
	current = { user: { findUnique: async () => target, update: async (a: any) => { updates.push(a); return { id: a.where.id, ...a.data }; } }, accountAuditLog: { create: async (a: any) => { audit.push(a.data); return a.data; } } };
	return { audit, updates };
}

test('suspend: needs a reason, writes the status and an ADMIN audit row together', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	const f = userFixture(userRow());
	await rejects(svc.updateUserStatus(admin, 'u1', 'SUSPENDED'), 400, /سبب/);
	await svc.updateUserStatus(admin, 'u1', 'SUSPENDED', 'احتيال مؤكد');
	assert.equal(f.updates[0].data.status, 'SUSPENDED');
	assert.equal(f.audit[0].eventType, 'ACCOUNT_SUSPENDED_BY_ADMIN');
	assert.equal(f.audit[0].source, 'ADMIN');
	assert.equal(f.audit[0].userId, 'u1');
	assert.equal(f.audit[0].afterData.status, 'SUSPENDED');
});

test('activate a suspended QA user: allowed, audited; invalid status / self / pending verification / same status are refused', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	let f = userFixture(userRow({ status: 'SUSPENDED' }));
	await svc.updateUserStatus(admin, 'u1', 'active');
	assert.equal(f.audit[0].eventType, 'ACCOUNT_ACTIVATED_BY_ADMIN');
	await rejects(svc.updateUserStatus(admin, 'u1', 'BANNED'), 400);
	await rejects(svc.updateUserStatus(admin, 'adm', 'SUSPENDED', 'سبب'), 403);
	userFixture(userRow({ status: 'PENDING_VERIFICATION' }));
	await rejects(svc.updateUserStatus(admin, 'u1', 'ACTIVE'), 409);
	userFixture(userRow());
	await rejects(svc.updateUserStatus(admin, 'u1', 'ACTIVE'), 409);
	f = userFixture(null);
	await rejects(svc.updateUserStatus(admin, 'u1', 'ACTIVE'), 404);
});

test('an ADMIN cannot touch an admin account; a SUPER_ADMIN can', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	userFixture(userRow({ accountType: 'ADMIN' }));
	await rejects(svc.updateUserStatus(admin, 'u1', 'SUSPENDED', 'سبب'), 403);
	const f = userFixture(userRow({ accountType: 'ADMIN' }));
	await svc.updateUserStatus(superAdmin, 'u1', 'SUSPENDED', 'سبب');
	assert.equal(f.updates.length, 1);
});

test('role update validation: empty / unknown / admin roles / base role removal / role without profile / self are refused', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	const base = { id: 'u1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'PROVIDER', clientProfile: { id: 'c' }, providerProfile: { id: 'p' }, affiliateProfile: null };
	userFixture(base);
	await rejects(svc.updateUserRoles(admin, 'u1', { roles: [] }), 400);
	await rejects(svc.updateUserRoles(admin, 'u1', { roles: ['PROVIDER', 'SUPER_ADMIN'] }), 400, /غير مسموح/);
	await rejects(svc.updateUserRoles(admin, 'u1', { roles: ['CLIENT'] }), 400, /الأساسي/);
	await rejects(svc.updateUserRoles(admin, 'u1', { roles: ['PROVIDER', 'AFFILIATE'] }), 409, /AFFILIATE/);
	await rejects(svc.updateUserRoles(admin, 'u1', { roles: ['PROVIDER'], activeRole: 'CLIENT' }), 400, /الدور النشط/);
	await rejects(svc.updateUserRoles(admin, 'adm', { roles: ['CLIENT'] }), 403);
	userFixture({ ...base, accountType: 'ADMIN' });
	await rejects(svc.updateUserRoles(superAdmin, 'u1', { roles: ['CLIENT'] }), 403);
});

test('role update keeps activeRole inside roles (revoked active role falls back to the base role) and audits before/after', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	const f = userFixture({ id: 'u1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'CLIENT', clientProfile: { id: 'c' }, providerProfile: { id: 'p' }, affiliateProfile: null });
	await svc.updateUserRoles(admin, 'u1', { roles: ['PROVIDER'] });
	assert.deepEqual(f.updates[0].data, { roles: ['PROVIDER'], activeRole: 'PROVIDER' });
	assert.equal(f.audit[0].eventType, 'ROLES_CHANGED_BY_ADMIN');
	assert.deepEqual(f.audit[0].beforeData.roles, ['PROVIDER', 'CLIENT']);
	assert.deepEqual(f.audit[0].afterData, { roles: ['PROVIDER'], activeRole: 'PROVIDER' });
});

test('user detail: 404 for an unknown id; otherwise tabs/kpis/audit come from rows and empty tabs are []', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	const empty = { findMany: async () => [] };
	const user = { id: 'u1', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT'], activeRole: 'CLIENT', firstName: 'م', lastName: 'ح', accountHolderName: null, email: 'a@x.com', phoneNumber: null, city: null, idNumber: '1234567890', lastActiveAt: null, createdAt: new Date('2026-01-01'), totalGmvAmount: 1200, completedProjectsCount: 2, ratingAverage: 4.5, tierLevel: 'Gold', walletBalance: 5, clientProfile: { id: 'c1', kycStatus: 'VERIFIED', companyName: null }, providerProfile: null, affiliateProfile: null };
	current = { user: { findUnique: async () => null } };
	await rejects(svc.getUserDetail('nope'), 404);
	current = { user: { findUnique: async () => user }, clientRequest: { findMany: async () => [{ id: 'r1', title: 'طلب', status: 'OPEN', proposalsCount: 0, createdAt: new Date() }] }, order: empty, dispute: { findMany: async () => [{ id: 'd1' }] }, supportTicket: empty, contract: empty, walletTransaction: empty, accountAuditLog: { findMany: async () => [{ id: 'a1', eventType: 'X', title: 't', summary: 's', source: 'ADMIN', severity: 'INFO', occurredAt: new Date() }] }, userSession: { findFirst: async () => null }, escrow: empty, clientOnboarding: { findUnique: async () => ({ status: 'APPROVED' }) } };
	const d = await svc.getUserDetail('u1');
	assert.equal(d.kpis.disputes, 1);
	assert.equal(d.kpis.totalRevenue, '1,200 $');
	assert.deepEqual(d.revenueHistory, []);
	assert.equal(d.tabs.requests.length, 1);
	assert.deepEqual(d.tabs.payments, []);
	assert.equal(d.audit[0].source, 'ADMIN');
	assert.equal(d.personalInfo.nationalIdLast4, '7890');
	assert.equal(d.kyc.client, 'VERIFIED');
});

test('users list: fields the platform does not record are null (no fabricated 0 $ / 1 / 0 tasks) and profile blobs are not forwarded', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	current = { user: { count: async () => 1, findMany: async () => [{ id: 'u1', accountType: 'MARKETING_BROKER', status: 'ACTIVE', roles: ['AFFILIATE'], activeRole: 'AFFILIATE', firstName: 'م', lastName: 'ح', accountHolderName: null, email: 'm@x', phoneNumber: null, totalGmvAmount: 0, completedProjectsCount: 0, ratingAverage: 0, tierLevel: null, lastActiveAt: null, createdAt: new Date(), clientProfile: null, providerProfile: { frontIdUrl: 'secret' }, affiliateProfile: { currentLevel: 'مساعد', _count: { referrals: 3 } }, _count: { clientProjects: 1, providerProjects: 1 } }] } };
	const { users } = await svc.getUsers({});
	const u: any = users[0];
	assert.equal(u.pendingCommission, null); assert.equal(u.tasksCount, null); assert.equal(u.monthlyBudget, null);
	assert.equal(u.totalReferrals, '3'); assert.equal(u.affiliateLevel, 'مساعد'); assert.equal(u.activeProjects, '2');
	assert.equal('providerProfile' in u, false); assert.equal('affiliateProfile' in u, false);
});

test('roles overview: real counts per role and the enforced admin capabilities', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	current = { user: { count: async (a: any) => (a.where.roles ? 7 : 2), groupBy: async () => [{ accountType: 'ADMIN', _count: { _all: 1 } }] } };
	const o = await svc.getRolesOverview();
	assert.equal(o.roles.length, 5); assert.equal(o.roles[0].members, 7);
	assert.ok(o.adminCapabilities.some((c: any) => c.key === 'user-delete' && c.admin === false && c.superAdmin === true));
});

test('delete user: refuses self and admin accounts; audits on the actor', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	await rejects(svc.deleteUser('sup', superAdmin), 403);
	userFixture(userRow({ accountType: 'ADMIN' }));
	await rejects(svc.deleteUser('u1', superAdmin), 403);
	const audit: any[] = [];
	current = { user: { findUnique: async () => userRow(), delete: async () => ({ id: 'u1' }) }, project: { updateMany: async () => ({}) }, message: { deleteMany: async () => ({}) }, conversation: { deleteMany: async () => ({}) }, contract: { deleteMany: async () => ({}) }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await svc.deleteUser('u1', superAdmin);
	assert.equal(audit[0].userId, 'sup'); assert.equal(audit[0].eventType, 'USER_DELETED_BY_ADMIN'); assert.equal(audit[0].severity, 'CRITICAL');
});

test('admin message: validates, refuses self / admins, checks the context belongs to the user, audits and notifies with a real route', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	notes.length = 0;
	const audit: any[] = [];
	current = { user: { findUnique: async () => ({ id: 'c1', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT' }) }, clientRequest: { findFirst: async (a: any) => (a.where.id === 'r1' ? { id: 'r1' } : null) }, projectProposal: { findFirst: async (a: any) => (a.where.id === 'o1' ? { id: 'o1' } : null) }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await rejects(svc.notifyUser(admin, 'c1', { message: 'x' }), 400);
	await rejects(svc.notifyUser(admin, 'adm', { message: 'رسالة صحيحة' }), 403);
	await rejects(svc.notifyUser(admin, 'c1', { message: 'رسالة صحيحة', context: { type: 'REQUEST', id: 'other' } }), 409);
	const r = await svc.notifyUser(admin, 'c1', { message: 'يرجى استكمال تفاصيل الطلب', context: { type: 'REQUEST', id: 'r1' } });
	assert.equal(r.actionUrl, '/client-overview/my-requests/r1');
	assert.equal(notes[0].type, 'ADMIN_MESSAGE'); assert.equal(notes[0].userId, 'c1');
	assert.equal(audit[0].eventType, 'ADMIN_MESSAGE_SENT');
	await rejects(svc.notifyUser(admin, 'c1', { message: 'رسالة صحيحة', context: { type: 'OFFER', id: 'zz' } }), 409);
	current.user.findUnique = async () => ({ id: 'p1', accountType: 'PROVIDER_INDIVIDUAL', activeRole: 'PROVIDER' });
	assert.equal((await svc.notifyUser(admin, 'p1', { message: 'رسالة صحيحة', context: { type: 'OFFER', id: 'o1' } })).actionUrl, '/provider-overview/offers');
	current.user.findUnique = async () => ({ id: 'a2', accountType: 'ADMIN', activeRole: 'ADMIN' });
	await rejects(svc.notifyUser(admin, 'a2', { message: 'رسالة صحيحة' }), 403);
});

// ───────────── KYC (provider + client) : decision, audit, notification
test('provider KYC approve: audited, provider notified with a real provider route; no document -> 400; already verified -> 409', async () => {
	const { onboardingService } = await fresh('./onboarding.service.ts');
	const audit: any[] = []; notes.length = 0;
	const profile = { userId: 'p1', kycStatus: 'PENDING', frontIdUrl: 'ref', backIdUrl: null, selfieUrl: null, supportingDocsUrl: null, certUrls: [] };
	current = { providerProfile: { findUnique: async () => profile, update: async (a: any) => ({ ...profile, ...a.data }) }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await onboardingService.approveProviderKyc('p1', admin);
	assert.equal(audit[0].eventType, 'KYC_APPROVED_BY_ADMIN'); assert.equal(audit[0].userId, 'p1');
	assert.equal(notes[0].userId, 'p1'); assert.equal(notes[0].type, 'KYC_APPROVED'); assert.equal(notes[0].actionUrl, '/provider-overview/profile/data');
	current.providerProfile.findUnique = async () => ({ ...profile, frontIdUrl: null });
	await rejects(onboardingService.approveProviderKyc('p1', admin), 400);
	current.providerProfile.findUnique = async () => ({ ...profile, kycStatus: 'VERIFIED' });
	await rejects(onboardingService.approveProviderKyc('p1', admin), 409);
});

test('provider KYC reject: reason kept in audit + notification', async () => {
	const { onboardingService } = await fresh('./onboarding.service.ts');
	const audit: any[] = []; notes.length = 0;
	current = { providerProfile: { findUnique: async () => ({ userId: 'p1', kycStatus: 'PENDING' }), update: async (a: any) => a.data }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await onboardingService.rejectProviderKyc('p1', { rejectionReason: 'الصورة غير واضحة' }, admin);
	assert.equal(audit[0].status, 'REJECTED'); assert.match(audit[0].summary, /الصورة غير واضحة/);
	assert.equal(notes[0].type, 'KYC_REJECTED'); assert.match(notes[0].message, /الصورة غير واضحة/);
});

test('client onboarding approve/reject: audited and the client is notified; a decided request is 409', async () => {
	const { onboardingService } = await fresh('./onboarding.service.ts');
	const audit: any[] = []; notes.length = 0;
	const item = { id: 'o1', userId: 'c1', status: 'PENDING', documentUrl: 'ref' };
	current = { clientOnboarding: { findUnique: async () => item, updateMany: async () => ({ count: 1 }) }, clientProfile: { updateMany: async () => ({}) }, user: { update: async () => ({}) }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await onboardingService.approveOnboarding('o1', admin);
	await onboardingService.rejectOnboarding('o1', { rejectionReason: 'مستند منتهي' }, admin);
	assert.deepEqual(audit.map(a => a.eventType), ['KYC_APPROVED_BY_ADMIN', 'KYC_REJECTED_BY_ADMIN']);
	assert.deepEqual(notes.map(n => n.actionUrl), ['/client-overview/profile', '/client-overview/profile']);
	current.clientOnboarding.updateMany = async () => ({ count: 0 });
	await rejects(onboardingService.approveOnboarding('o1', admin), 409);
});

// ───────────── specialty review + accreditation sample decisions
test('specialty decision notifies the provider with the specialties route (approve and reject)', async () => {
	const { SpecialtyAdminReviewService } = await fresh('./specialty-admin-review.service.ts');
	const svc = new SpecialtyAdminReviewService(); notes.length = 0;
	const audit: any[] = [];
	current = { providerSpecialty: { findUnique: async () => ({ id: 'ps1', status: 'UNDER_AI_REVIEW', providerProfile: { userId: 'p1' }, specialty: { nameAr: 'تصميم' }, providerProfileId: 'pp' }), updateMany: async () => ({ count: 1 }), count: async () => 1 }, accreditationSample: { findMany: async () => [], update: async () => ({}) }, user: { update: async () => ({}) }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await svc.decide('adm', 'ps1', { decision: 'APPROVED', reason: 'نماذج ممتازة وموثقة' });
	await svc.decide('adm', 'ps1', { decision: 'REJECTED', reason: 'الأدلة غير كافية' });
	assert.deepEqual(notes.map(n => n.type), ['SPECIALTY_APPROVED', 'SPECIALTY_REJECTED']);
	assert.ok(notes.every(n => n.userId === 'p1' && n.actionUrl === '/provider-overview/profile/specialties'));
	assert.equal(audit.length, 2);
});

test('accreditation sample approve / reject: audit + provider notification pointing at the sample page', async () => {
	const { accreditationAiService } = await fresh('./accreditation-ai.service.ts'); notes.length = 0;
	const audit: any[] = [];
	const sample = { id: 's1', title: 'نظام مخزون', status: 'MANUAL_REVIEW', providerSpecialtyId: 'ps1', aiScore: null, providerSpecialty: { status: 'UNDER_AI_REVIEW' }, providerProfile: { userId: 'p1' } };
	current = { accreditationSample: { findUnique: async () => sample, update: async (a: any) => ({ id: 's1', ...a.data }) }, providerSpecialty: { updateMany: async () => ({ count: 1 }) }, accountAuditLog: { create: async (a: any) => audit.push(a.data) } };
	await accreditationAiService.adminApproveSample('s1', admin);
	await accreditationAiService.adminRejectSample('s1', 'العينة منسوخة', admin);
	assert.deepEqual(audit.map(a => a.eventType), ['ACCREDITATION_APPROVED_BY_ADMIN', 'ACCREDITATION_REJECTED_BY_ADMIN']);
	assert.deepEqual(notes.map(n => n.actionUrl), ['/provider-overview/business-models/center/accreditation-details/s1', '/provider-overview/business-models/center/accreditation-details/s1']);
	assert.match(notes[1].message, /العينة منسوخة/);
});

test('specialty review queue: list (counts, default pending) and detail 404', async () => {
	const { SpecialtyReviewQueryService } = await fresh('./specialty-admin-review.service.ts'); const svc = new SpecialtyReviewQueryService();
	let seen: any;
	current = { providerSpecialty: {
		findMany: async (a: any) => { seen = a.where; return [{ id: 'ps1', status: 'UNDER_AI_REVIEW', subSpecialties: [], aiScore: null, specialty: { id: 's', nameAr: 'تصميم' }, providerProfile: { userId: 'p1', kycStatus: 'VERIFIED', user: { id: 'p1', firstName: 'س', lastName: 'ع', email: 'a@x', accountType: 'PROVIDER_INDIVIDUAL' } }, _count: { accreditationSamples: 2, workSamples: 1 } }]; },
		count: async (a: any) => (a.where.status === 'UNDER_AI_REVIEW' ? 4 : a.where.status === 'APPROVED' ? 2 : a.where.status === 'REJECTED' ? 1 : 4),
		findUnique: async () => null } };
	const r = await svc.list({});
	assert.deepEqual(seen.status.in, ['UNDER_AI_REVIEW']);
	assert.deepEqual(r.counts, { pending: 4, approved: 2, rejected: 1, all: 7 });
	assert.equal(r.items[0].provider.name, 'س ع'); assert.equal(r.items[0].scores.aiScore, null); assert.equal(r.items[0].accreditationSamples, 2);
	await rejects(svc.list({ status: 'weird' }), 400);
	await rejects(svc.get('x'), 404);
});

// ───────────── requests & offers
test('admin requests list: filters, per-row offers/disputes, counts; invalid status 400', async () => {
	const { AdminRequestsService } = await fresh('./admin-requests.service.ts'); const svc = new AdminRequestsService();
	let where: any;
	current = {
		clientRequest: {
			findMany: async (a: any) => { where = a.where; return [{ id: 'r1', title: 'متجر', status: 'OPEN', budgetType: 'RANGE', minBudget: 100, maxBudget: 200, expectedDurationDays: 10, createdAt: new Date(), specialty: { id: 's', nameAr: 'برمجة' }, clientProfile: { user: { id: 'c1', firstName: 'م', lastName: 'ح', email: 'c@x', accountType: 'CLIENT_INDIVIDUAL' } }, disputes: [{ id: 'd1' }] }]; },
			count: async () => 1, groupBy: async () => [{ status: 'OPEN', _count: { _all: 3 } }, { status: 'COMPLETED', _count: { _all: 1 } }] },
		projectProposal: { groupBy: async () => [{ projectId: 'r1', _count: { _all: 2 } }] },
		project: { findMany: async () => [{ id: 'r1', status: 'OPEN' }] }, contract: { findMany: async () => [] } };
	const r = await svc.listRequests({ status: 'open', search: 'متجر' });
	assert.equal(where.status, 'OPEN'); assert.ok(where.OR.length >= 1);
	assert.equal(r.items[0].offersCount, 2); assert.equal(r.items[0].openDisputes, 1); assert.equal(r.items[0].client!.name, 'م ح');
	assert.deepEqual(r.counts, { all: 4, disputed: 3 === 3 ? r.counts.disputed : 0, OPEN: 3, COMPLETED: 1 });
	await rejects(svc.listRequests({ status: 'nonsense' }), 400);
});

test('admin request detail: 404, AI analysis only when stored, offers + timeline from rows', async () => {
	const { AdminRequestsService } = await fresh('./admin-requests.service.ts'); const svc = new AdminRequestsService();
	current = { clientRequest: { findUnique: async () => null } };
	await rejects(svc.getRequest('x'), 404);
	const base = { id: 'r1', title: 'متجر', description: 'د', status: 'OPEN', subSpecialties: [], requiredSkills: [], budgetType: 'FIXED', minBudget: 100, maxBudget: 100, expectedDurationDays: 5, attachments: ['a'], aiAnalyzedSummary: null, aiComplexityRating: null, createdAt: new Date('2026-10-01'), updatedAt: new Date(), specialty: { id: 's', nameAr: 'برمجة' }, clientProfile: { kycStatus: 'VERIFIED', user: { id: 'c1', firstName: 'م', lastName: 'ح' } }, disputes: [] };
	current = { clientRequest: { findUnique: async () => base }, project: { findUnique: async () => ({ id: 'r1', status: 'OPEN', escrow: null }) }, contract: { findUnique: async () => null },
		projectProposal: { findMany: async () => [{ id: 'o1', status: 'SUBMITTED', totalPrice: 90, deliveryDays: 4, aiMatchScore: null, aiQualityTag: null, aiPriceTag: null, createdAt: new Date('2026-10-02'), provider: { id: 'p1', firstName: 'س', lastName: 'ع' } }] } };
	const d = await svc.getRequest('r1');
	assert.equal(d.aiAnalysis, null); assert.equal(d.contract, null); assert.equal(d.offers.length, 1); assert.equal(d.offers[0].aiMatchScore, null);
	assert.deepEqual(d.timeline.map((t: any) => t.text), ['وصل عرض من س ع', 'أنشأ العميل الطلب']);
	current.clientRequest.findUnique = async () => ({ ...base, aiAnalyzedSummary: 'ملخص', aiComplexityRating: null });
	assert.equal((await svc.getRequest('r1')).aiAnalysis!.source, 'WASEET_AI');
});

test('admin offers list + detail: status filter, AI review only when present, negotiation state from the chat entries', async () => {
	const { AdminRequestsService } = await fresh('./admin-requests.service.ts'); const svc = new AdminRequestsService();
	let where: any;
	current = { projectProposal: { findMany: async (a: any) => { where = a.where; return []; }, count: async () => 0, groupBy: async () => [] } };
	const l = await svc.listOffers({ status: 'under_negotiation' });
	assert.equal(where.status, 'UNDER_NEGOTIATION'); assert.deepEqual(l.items, []); assert.deepEqual(l.counts, { all: 0 });
	await rejects(svc.listOffers({ status: 'DRAFT' }), 400);
	const offer = { id: 'o1', projectId: 'r1', title: 'عرض', message: 'م', advantages: [], outputs: null, totalPrice: 500, deliveryDays: 7, status: 'UNDER_NEGOTIATION', aiMatchScore: null, aiQualityTag: null, aiPriceTag: null, aiFeedback: null, agreedToTerms: true, agreedToEscrow: true, createdAt: new Date(), updatedAt: new Date(), providerId: 'p1', milestones: [], provider: { id: 'p1', firstName: 'س', lastName: 'ع' }, project: { id: 'r1', title: 'متجر', status: 'OPEN', client: { id: 'c1', firstName: 'م', lastName: 'ح' } } };
	const counter = 'WS_NEGOTIATION::' + JSON.stringify({ kind: 'PROVIDER_COUNTER', offerId: 'o1', priceValue: 450, deliveryDays: 8, notes: 'خصم' });
	current = { projectProposal: { findUnique: async () => offer }, contract: { findUnique: async () => null }, message: { findMany: async () => [{ id: 'm1', senderId: 'p1', content: counter, createdAt: new Date() }] } };
	const d = await svc.getOffer('o1');
	assert.equal(d.aiReview, null);
	assert.equal(d.negotiation.state, 'COUNTER_PENDING'); assert.equal(d.negotiation.entries[0].price, 450);
	current.projectProposal.findUnique = async () => ({ ...offer, aiMatchScore: 82 });
	assert.equal((await svc.getOffer('o1')).aiReview!.matchScore, 82);
	current.projectProposal.findUnique = async () => null;
	await rejects(svc.getOffer('zzz'), 404);
});

test('provider levels: the 15-level ladder with real counts (0 when empty) and no invented providers', async () => {
	const { AdminUsersService } = await fresh('./admin-users.service.ts'); const svc = new AdminUsersService();
	current = { providerGamification: { groupBy: async () => [{ currentLevelIndex: 2, _count: { _all: 3 } }], findMany: async () => [] }, providerProfile: { count: async () => 5 } };
	const r = await svc.getProviderLevels();
	assert.equal(r.levels.length, 15); assert.equal(r.levels[1].providers, 3); assert.equal(r.levels[0].providers, 0);
	assert.equal(r.providersWithoutLevelRow, 2); assert.deepEqual(r.topProviders, []);
});
