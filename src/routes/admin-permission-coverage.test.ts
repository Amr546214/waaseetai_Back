import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Deny by default, proven structurally: EVERY route of EVERY router mounted under /admin (and the other admin-only routes) must pass through a permission / owner / member / self guard
// from admin-access.middleware, either through a router-level guard registered before it or on the route itself. A new admin route without a guard fails here.
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'test-key';
const emptyModel: any = new Proxy({}, { get: () => async () => null });
const prisma: any = new Proxy({}, { get: () => emptyModel });
mock.module('../config/db', { namedExports: { prisma } });
mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's' }) } } });

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8');
const imports = new Map<string, { file: string; name: string }>();
for (const m of appSource.matchAll(/import\s+(\w+)\s+from\s+'(\.\/routes\/[^']+)'/g)) imports.set(m[1], { file: m[2], name: 'default' });
for (const m of appSource.matchAll(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+'(\.\/routes\/[^']+)'/g)) { imports.set(m[1], { file: m[3], name: 'default' }); for (const n of m[2].split(',').map(x => x.trim())) imports.set(n, { file: m[3], name: n }); }
for (const m of appSource.matchAll(/import\s+\{([^}]+)\}\s+from\s+'(\.\/routes\/[^']+)'/g)) for (const n of m[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop()!)) imports.set(n, { file: m[2], name: n });
const mounts = [...appSource.matchAll(/mountAppRoute\('\/api\/admin\/([\w-]+)',\s*(\w+)\)/g)].map(m => ({ prefix: m[1], ident: m[2] }));

const isGuard = (h: any) => !!(h && (h.adminPermissions || h.adminOwnerOnly || h.adminMember || h.adminSelf));

test('every route of every /admin router is behind a permission / owner / member / self guard (deny by default)', async () => {
	assert.ok(mounts.length >= 25, `found ${mounts.length} mounts`);
	const unguarded: string[] = [];
	for (const { prefix, ident } of mounts) {
		const ref = imports.get(ident)!; assert.ok(ref, ident);
		const mod: any = await import(`${ref.file.replace('./routes/', './')}.ts`);
		const router = mod[ref.name]; assert.ok(router, `${prefix}: router export`);
		let guarded = false;
		for (const layer of router.stack as any[]) {
			if (!layer.route) { if (isGuard(layer.handle)) guarded = true; continue; }
			const own = (layer.route.stack as any[]).some(l => isGuard(l.handle));
			if (!guarded && !own) unguarded.push(`${prefix} ${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
		}
	}
	assert.deepEqual(unguarded, [], `routes without a permission guard:\n${unguarded.join('\n')}`);
});

test('every permission id used by a guard exists in the registry (a typo would silently deny everything)', async () => {
	const { isKnownPermission } = await import('../config/admin-permissions');
	const used = new Set<string>();
	for (const { ident } of mounts) {
		const ref = imports.get(ident)!; const router = ((await import(`${ref.file.replace('./routes/', './')}.ts`)) as any)[ref.name];
		const walk = (h: any) => { if (h?.adminPermissions) h.adminPermissions.forEach((p: string) => used.add(p)); };
		for (const layer of router.stack as any[]) { if (layer.route) layer.route.stack.forEach((l: any) => walk(l.handle)); else walk(layer.handle); }
	}
	assert.ok(used.size >= 20, `ids used: ${used.size}`);
	for (const id of used) assert.ok(isKnownPermission(id), `unknown permission id ${id}`);
});

test('no admin route file still authorizes by ADMIN / SUPER_ADMIN account type (the old way around the permission system)', () => {
	const dir = path.join(__dirname);
	const offenders: string[] = [];
	for (const f of fs.readdirSync(dir).filter(x => /^(admin-.*|business-models|provider-profile)\.routes\.ts$/.test(x))) {
		const src = fs.readFileSync(path.join(dir, f), 'utf8');
		if (/authorize\(\s*AccountType\.(ADMIN|SUPER_ADMIN)/.test(src)) offenders.push(f);
	}
	assert.deepEqual(offenders, []);
});

test('registry: ids are unique and stable-looking, every template only uses known ids, owner-only capabilities are not permissions', async () => {
	const { ADMIN_PERMISSIONS, ADMIN_ROLE_TEMPLATES, OWNER_ONLY_CAPABILITIES, isKnownPermission } = await import('../config/admin-permissions');
	const ids = ADMIN_PERMISSIONS.map(p => p.id);
	assert.equal(new Set(ids).size, ids.length); for (const id of ids) assert.match(id, /^[a-z_]+\.[a-z_]+$/);
	for (const t of ADMIN_ROLE_TEMPLATES) for (const p of t.permissions) assert.ok(isKnownPermission(p), `${t.key}: ${p}`);
	for (const c of OWNER_ONLY_CAPABILITIES) assert.ok(!isKnownPermission(c), `${c} must not be grantable`);
	// read / approve / reject / payout are four distinct ids
	for (const id of ['withdrawals.review', 'withdrawals.approve', 'withdrawals.reject', 'payouts.send', 'finance.read']) assert.ok(ids.includes(id));
	// no template hands out the owner-only powers or the money-moving ids beyond what the design shows
	for (const t of ADMIN_ROLE_TEMPLATES) { assert.ok(!t.permissions.includes('payouts.send'), t.key); assert.ok(!t.permissions.includes('users.delete'), t.key); }
});

test('dashboard shaping removes (does not zero) what the caller cannot see', async () => {
	const { shapeSummary, shapeCharts, shapeActivity } = await import('../utils/admin-dashboard-shaping');
	const actor = (...p: string[]) => ({ userId: 'u', isOwner: false, staffId: 's', staffStatus: 'ACTIVE' as const, roleId: 'r', roleName: 'x', permissions: new Set(p) });
	const sum = { kpis: { users: { total: 5 }, revenue: { total: 9 }, disputes: { open: 1 }, tickets: { open: 2 }, withdrawals: { pending: 3 }, projects: { active: 1 } }, queues: [{ key: 'withdrawals' }, { key: 'tickets' }, { key: 'kyc' }], alerts: [{ key: 'pendingWithdrawals' }, { key: 'kycOver24h' }] };
	const a = shapeSummary(sum, actor('support.review')); assert.deepEqual(Object.keys(a.kpis).sort(), ['projects', 'tickets']); assert.deepEqual(a.queues.map((q: any) => q.key), ['tickets']); assert.deepEqual(a.alerts, []);
	const b = shapeSummary(sum, actor('finance.read', 'withdrawals.review', 'identity.review')); assert.ok(b.kpis.revenue && b.kpis.withdrawals && !b.kpis.users); assert.deepEqual(b.queues.map((q: any) => q.key), ['withdrawals', 'kyc']);
	const c = shapeCharts({ registrations: [1], registrationsTotal: 1, commission: [2], commissionTotal: 2, projectsByStatus: [] }, actor('users.view')); assert.deepEqual(Object.keys(c).sort(), ['registrations', 'registrationsTotal']);
	const d = shapeActivity({ items: [{ kind: 'DISPUTE_OPENED' }, { kind: 'USER_REGISTERED' }, { kind: 'ADMIN_ACTION' }, { kind: 'UNKNOWN' }] }, actor('disputes.view')); assert.deepEqual(d.items.map((i: any) => i.kind), ['DISPUTE_OPENED']);
});
