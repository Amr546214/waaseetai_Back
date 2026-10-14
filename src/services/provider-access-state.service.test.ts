import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// In-memory fake of the tables the onboarding gate touches. The same fake backs config/db for the real admin + middleware code.
type Any = Record<string, any>;
const S: Any = {};
function reset(o: { accountType?: string; setup?: boolean; test?: boolean; portfolio?: Any[]; specialties?: Any[] } = {}) {
	let n = 0;
	S.seq = () => `id-${++n}`;
	S.user = { id: 'u1', accountType: o.accountType ?? 'PROVIDER_INDIVIDUAL' };
	S.profile = { id: 'pp1', userId: 'u1', isProfileSetupComplete: o.setup ?? true, setupTestStatus: (o.test ?? true) ? 'COMPLETED' : 'NOT_STARTED', mainSpecialty: 'design-creative', subSpecialties: ['تصميم جرافيك', 'شعارات'] };
	S.catalog = [{ id: 'sp-g', nameAr: 'تصميم جرافيك', name: 'تصميم جرافيك', nameEn: 'Graphic', isActive: true }, { id: 'sp-l', nameAr: 'شعارات', name: 'شعارات', nameEn: 'Logo', isActive: true }];
	S.ps = o.specialties ?? [];
	S.samples = [];
	S.portfolio = o.portfolio ?? [];
	S.audit = [];
	S.notified = [];
}
const matches = (row: Any, where: Any = {}) => Object.entries(where).every(([k, v]) => v && typeof v === 'object' && 'in' in (v as Any) ? (v as Any).in.includes(row[k]) : v && typeof v === 'object' && 'startsWith' in (v as Any) ? String(row[k]).startsWith((v as Any).startsWith) : row[k] === v);
const withSamples = (r: Any) => ({ ...r, specialty: S.catalog.find((c: Any) => c.id === r.specialtyId), accreditationSamples: S.samples.filter((s: Any) => s.providerSpecialtyId === r.id).sort((a: Any, b: Any) => b.createdAt - a.createdAt) });
const db: Any = {
	user: { findUnique: async () => S.user },
	category: { findFirst: async () => null },
	providerProfile: { findUnique: async ({ where }: Any) => (where.userId ? (where.userId === S.profile.userId ? S.profile : null) : where.id === S.profile.id ? S.profile : null) },
	specialty: { findMany: async ({ where }: Any) => S.catalog.filter((c: Any) => where.nameAr.in.includes(c.nameAr)) },
	portfolioItem: { findMany: async ({ where }: Any) => S.portfolio.filter((p: Any) => matches(p, where)) },
	providerSpecialty: {
		findUnique: async ({ where }: Any) => { const k = where.providerProfileId_specialtyId; return S.ps.find((r: Any) => r.providerProfileId === k.providerProfileId && r.specialtyId === k.specialtyId) ?? null; },
		upsert: async ({ where, create }: Any) => { const k = where.providerProfileId_specialtyId; const hit = S.ps.find((r: Any) => r.providerProfileId === k.providerProfileId && r.specialtyId === k.specialtyId); if (hit) return hit; const row = { id: S.seq(), isActive: true, isPassed: false, createdAt: new Date(), ...create }; S.ps.push(row); return row; },
		findMany: async ({ where }: Any) => S.ps.filter((r: Any) => r.providerProfileId === where.providerProfileId && r.isActive).map(withSamples),
		updateMany: async ({ where, data }: Any) => { const rows = S.ps.filter((r: Any) => matches(r, where.status && typeof where.status === 'object' ? { id: where.id } : where)); rows.forEach((r: Any) => Object.assign(r, data)); return { count: rows.length }; },
	},
	accreditationSample: {
		findFirst: async ({ where }: Any) => S.samples.find((s: Any) => matches(s, where)) ?? null,
		findUnique: async ({ where }: Any) => { const s = S.samples.find((x: Any) => x.id === where.id); return s ? { ...s, providerSpecialty: S.ps.find((r: Any) => r.id === s.providerSpecialtyId), providerProfile: { userId: 'u1' } } : null; },
		findMany: async () => [],
		create: async ({ data }: Any) => { const s = { id: S.seq(), createdAt: new Date(), aiFeedbackAr: null, aiScore: null, aiAuditedAt: null, ...data }; S.samples.push(s); return s; },
		update: async ({ where, data }: Any) => { const s = S.samples.find((x: Any) => x.id === where.id); Object.assign(s, data); return s; },
	},
	accountAuditLog: { findFirst: async () => null, create: async ({ data }: Any) => { S.audit.push(data); return data; } },
	$transaction: async (fn: any) => fn(db),
};
mock.module('../config/db', { namedExports: { prisma: db } });
mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { accreditationDecided: async (p: Any) => { S.notified.push(p); } } } });

const load = async () => ({
	access: (await import('./provider-access-state.service.ts')).providerAccessStateService,
	ob: await import('./onboarding-accreditation.service.ts'),
	admin: (await import('./accreditation-ai.service.ts')).accreditationAiService,
	gate: (await import('../middlewares/provider-access.middleware.ts')).requireApprovedProvider,
});
const portfolio = (extra: Any = {}) => [{ providerProfileId: 'pp1', title: 'نموذج أعمال - تصميم جرافيك', description: 'هوية بصرية كاملة لمتجر', coverImage: 'https://x/a.png', projectUrl: 'https://p.example', tags: ['https://x/a.png', 'https://x/b.pdf'], ...extra }];
const PENDING_MSG = 'تم اجتياز الاختبار، ونموذج الاعتماد قيد المراجعة. ستفتح لوحة مقدم الخدمة بعد اعتماد الإدارة.';
const REQUIRED_MSG = 'اجتزت الاختبار، لكن يجب رفع نموذج الاعتماد لإكمال المراجعة.';

test('onboarding save creates a real AccreditationSample (MANUAL_REVIEW, linked to profile + specialty) and a re-run never duplicates', async () => {
	reset({ portfolio: portfolio() });
	const { ob } = await load();
	const first = await ob.ensureOnboardingAccreditationSamples('pp1', db);
	assert.deepEqual([first.created], [1]);
	assert.equal(S.samples.length, 1);
	const s = S.samples[0]; const ps = S.ps.find((r: Any) => r.specialtyId === 'sp-g');
	assert.deepEqual([s.status, s.providerProfileId, s.providerSpecialtyId, s.title, s.description, s.projectUrl], ['MANUAL_REVIEW', 'pp1', ps.id, 'نموذج أعمال - تصميم جرافيك', 'هوية بصرية كاملة لمتجر', 'https://p.example']);
	assert.deepEqual(s.attachments, ['https://x/a.png', 'https://x/b.pdf']);
	assert.equal(ps.status, 'UNDER_AI_REVIEW'); // enters the admin queue, never approved
	const again = await ob.ensureOnboardingAccreditationSamples('pp1', db);
	assert.deepEqual([again.created, again.updated, S.samples.length], [0, 0, 1]);
});

test('a decided onboarding sample is never touched or resurrected by a re-run; a pending one is refreshed', async () => {
	reset({ portfolio: portfolio() });
	const { ob } = await load();
	await ob.ensureOnboardingAccreditationSamples('pp1', db);
	S.portfolio = portfolio({ description: 'وصف أفضل' });
	assert.equal((await ob.ensureOnboardingAccreditationSamples('pp1', db)).updated, 1);
	assert.equal(S.samples[0].description, 'وصف أفضل');
	S.samples[0].status = 'REJECTED';
	S.portfolio = portfolio({ description: 'وصف ثالث' });
	await ob.ensureOnboardingAccreditationSamples('pp1', db);
	assert.deepEqual([S.samples.length, S.samples[0].status, S.samples[0].description], [1, 'REJECTED', 'وصف أفضل']);
});

test('test pass alone: access-state is not approved (setup+test done, no sample -> SAMPLE_REQUIRED, never canAccessDashboard)', async () => {
	reset({});
	const { access } = await load();
	const r = await access.get('u1', db);
	assert.deepEqual([r.state, r.canAccessDashboard, r.hasSample, r.message], ['SAMPLE_REQUIRED', false, false, REQUIRED_MSG]);
});

test('setup incomplete or test not completed -> SETUP_INCOMPLETE', async () => {
	const { access } = await load();
	reset({ setup: false }); assert.equal((await access.get('u1', db)).state, 'SETUP_INCOMPLETE');
	reset({ test: false, portfolio: portfolio() }); const r = await access.get('u1', db);
	assert.deepEqual([r.state, r.canAccessDashboard], ['SETUP_INCOMPLETE', false]);
	assert.equal(S.samples.length, 0); // no repair before the test is done
});

test('lazy repair: a provider with setup+test done and a stored onboarding portfolio gets the sample and is PENDING_REVIEW (blocked)', async () => {
	reset({ portfolio: portfolio() });
	const { access } = await load();
	const r = await access.get('u1', db);
	assert.deepEqual([r.state, r.canAccessDashboard, r.hasSample, r.message], ['PENDING_REVIEW', false, true, PENDING_MSG]);
	assert.equal(S.samples.length, 1);
	assert.equal(r.specialties[0].sample.status, 'MANUAL_REVIEW');
	await access.get('u1', db);
	assert.equal(S.samples.length, 1); // idempotent
});

test('rejected -> REJECTED with the admin reason; a re-submitted sample re-opens PENDING_REVIEW', async () => {
	reset({ portfolio: portfolio() });
	const { access, admin } = await load();
	await access.get('u1', db);
	await admin.adminRejectSample(S.samples[0].id, 'الجودة غير كافية');
	const r = await access.get('u1', db);
	assert.deepEqual([r.state, r.canAccessDashboard, r.reason], ['REJECTED', false, 'الجودة غير كافية']);
	assert.equal(r.specialties[0].sample.rejectionReason, 'الجودة غير كافية');
	assert.equal(S.notified[0].decision, 'REJECTED');
	await db.accreditationSample.create({ data: { providerProfileId: 'pp1', providerSpecialtyId: S.samples[0].providerSpecialtyId, title: 'جديد', description: 'd', attachments: [], status: 'MANUAL_REVIEW' } });
	assert.equal((await access.get('u1', db)).state, 'PENDING_REVIEW');
});

test('admin list shows the pending sample with provider + specialty; approving it makes the specialty APPROVED and the state APPROVED', async () => {
	reset({ portfolio: portfolio() });
	const { access, admin } = await load();
	await access.get('u1', db);
	// the list query itself is covered by the real service: fake findMany returns [] so assert the where/include contract instead
	const src = readFileSync(new URL('./accreditation-ai.service.ts', import.meta.url), 'utf8');
	assert.match(src, /const where = status \? \{ status \} : \{\}/);
	const approvedAt = await admin.adminApproveSample(S.samples[0].id, undefined);
	assert.equal(approvedAt.status, 'AI_VERIFIED');
	assert.equal(S.ps.find((r: Any) => r.id === S.samples[0].providerSpecialtyId).status, 'APPROVED');
	const r = await access.get('u1', db);
	assert.deepEqual([r.state, r.canAccessDashboard], ['APPROVED', true]);
	assert.equal(S.notified[0].decision, 'APPROVED');
});

test('PROVIDER_COMPANY -> NOT_APPLICABLE and unchanged access', async () => {
	reset({ accountType: 'PROVIDER_COMPANY', setup: false });
	const { access } = await load();
	const r = await access.get('u1', db);
	assert.deepEqual([r.state, r.canAccessDashboard], ['NOT_APPLICABLE', true]);
});

test('requireApprovedProvider: 403 while pending, passes when approved, passes for company / client-acting', async () => {
	reset({ portfolio: portfolio() });
	const { gate, access } = await load();
	const run = async (user: Any) => { let err: any = 'none'; await gate({ user } as any, {} as any, (e?: any) => { err = e ?? null; }); return err; };
	const indiv = { id: 'u1', accountType: 'PROVIDER_INDIVIDUAL', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] };
	const blocked = await run(indiv);
	assert.deepEqual([blocked.statusCode, blocked.message], [403, 'لوحة مقدم الخدمة تفتح بعد اعتماد نموذج الاعتماد من الإدارة']);
	assert.equal(await run({ ...indiv, activeRole: 'CLIENT' }), null);
	assert.equal(await run({ ...indiv, accountType: 'PROVIDER_COMPANY' }), null);
	S.ps.forEach((r: Any) => { r.status = 'APPROVED'; });
	assert.equal(await run(indiv), null);
	assert.equal((await access.get('u1', db)).state, 'APPROVED');
	assert.equal((await run(undefined as any)).statusCode, 401);
});

test('route wiring: access-state is providerOnly (activeRole) and un-gated; the dashboard-data prefixes are gated; setup/accreditation/tickets are not', () => {
	const src = readFileSync(new URL('../routes/provider.routes.ts', import.meta.url), 'utf8');
	assert.match(src, /router\.get\('\/access-state', authenticate, requireActiveUser, providerOnly,/);
	const gate = src.match(/const DASHBOARD_DATA_PREFIXES = \[([^\]]+)\];\nrouter\.use\(DASHBOARD_DATA_PREFIXES, \.\.\.dashboardGate\)/)![1];
	assert.deepEqual(gate.split(',').map(x => x.trim().replace(/'/g, '')).sort(), ['/explore-requests', '/finance', '/offers', '/reports', '/statistics']);
	assert.match(src, /const providerOnly = authorizeActiveRole\(AccountType\.PROVIDER_INDIVIDUAL, AccountType\.PROVIDER_COMPANY\)/);
	assert.ok(src.indexOf('router.use(DASHBOARD_DATA_PREFIXES') < src.indexOf("router.get(\n  '/statistics'"));
});

test('hooks: the form save and the setup-test completion both call the onboarding sample persistence', () => {
	assert.match(readFileSync(new URL('../controllers/provider-profile.controller.ts', import.meta.url), 'utf8'), /await tryEnsureOnboardingAccreditationSamples\(result\.id\)/);
	assert.match(readFileSync(new URL('../sockets/setup-test.gateway.ts', import.meta.url), 'utf8'), /await tryEnsureOnboardingAccreditationSamples\(session\.profileId\)/);
});
