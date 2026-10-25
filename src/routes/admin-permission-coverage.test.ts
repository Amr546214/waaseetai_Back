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

const isGuard = (h: any) => !!(h && (h.adminPermissions || h.adminSuperAdminOnly || h.adminMember || h.adminSelf || h.adminScoped));

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
	const { ADMIN_PERMISSIONS, ADMIN_ROLE_TEMPLATES, SUPER_ADMIN_ONLY_CAPABILITIES, isKnownPermission } = await import('../config/admin-permissions');
	const ids = ADMIN_PERMISSIONS.map(p => p.id);
	assert.equal(new Set(ids).size, ids.length); for (const id of ids) assert.match(id, /^[a-z_]+\.[a-z_]+$/);
	for (const t of ADMIN_ROLE_TEMPLATES) for (const p of t.permissions) assert.ok(isKnownPermission(p), `${t.key}: ${p}`);
	for (const c of SUPER_ADMIN_ONLY_CAPABILITIES) assert.ok(!isKnownPermission(c), `${c} must not be grantable`);
	// read / approve / reject / payout are four distinct ids
	for (const id of ['withdrawals.review', 'withdrawals.approve', 'withdrawals.reject', 'payouts.send', 'finance.read']) assert.ok(ids.includes(id));
	// no template hands out the owner-only powers or the money-moving ids beyond what the design shows
	for (const t of ADMIN_ROLE_TEMPLATES) { assert.ok(!t.permissions.includes('payouts.send'), t.key); assert.ok(!t.permissions.includes('users.delete'), t.key); }
});

test('dashboard shaping removes (does not zero) what the caller cannot see', async () => {
	const { shapeSummary, shapeCharts, shapeActivity } = await import('../utils/admin-dashboard-shaping');
	const actor = (...p: string[]) => ({ userId: 'u', isSuperAdmin: false, staffId: 's', staffStatus: 'ACTIVE' as const, roleId: 'r', roleName: 'x', permissions: new Set(p) });
	const sum = { kpis: { users: { total: 5 }, revenue: { total: 9 }, disputes: { open: 1 }, tickets: { open: 2 }, withdrawals: { pending: 3 }, projects: { active: 1 } }, queues: [{ key: 'withdrawals' }, { key: 'tickets' }, { key: 'kyc' }], alerts: [{ key: 'pendingWithdrawals' }, { key: 'kycOver24h' }] };
	const a = shapeSummary(sum, actor('support.review')); assert.deepEqual(Object.keys(a.kpis).sort(), ['projects', 'tickets']); assert.deepEqual(a.queues.map((q: any) => q.key), ['tickets']); assert.deepEqual(a.alerts, []);
	const b = shapeSummary(sum, actor('finance.read', 'withdrawals.review', 'identity.review')); assert.ok(b.kpis.revenue && b.kpis.withdrawals && !b.kpis.users); assert.deepEqual(b.queues.map((q: any) => q.key), ['withdrawals', 'kyc']);
	const c = shapeCharts({ registrations: [1], registrationsTotal: 1, commission: [2], commissionTotal: 2, projectsByStatus: [] }, actor('users.view')); assert.deepEqual(Object.keys(c).sort(), ['registrations', 'registrationsTotal']);
	const d = shapeActivity({ items: [{ kind: 'DISPUTE_OPENED' }, { kind: 'USER_REGISTERED' }, { kind: 'ADMIN_ACTION' }, { kind: 'UNKNOWN' }] }, actor('disputes.view')); assert.deepEqual(d.items.map((i: any) => i.kind), ['DISPUTE_OPENED']);
});

// The routes under /admin are not the only way to reach admin data or actions (sockets, assistant, knowledge, notifications, services that special-case an admin). Every non-test source file that
// decides by ADMIN / SUPER_ADMIN account type must be listed here WITH the reason it is not an access bypass; a new file doing so fails until someone reviews it.
const ACCOUNT_TYPE_DECISIONS: Record<string, string> = {
	'middlewares/auth.middleware.ts': 'equivalence of account type and role for authorize(); no admin route uses it any more (coverage test above); authorizeAdminActing only stacks after a permission guard',
	'middlewares/admin-access.middleware.ts': 'the permission system itself',
	'services/admin-access.service.ts': 'the permission system itself (an admin-type account is only the precondition for a lookup)',
	'services/admin-operations-scope.service.ts': 'scope rule for operations records',
	'services/admin-staff.service.ts': 'the account must be an admin-type account to be placed in the team',
	'services/admin-invites.service.ts': 'creates the ADMIN account of an accepted invitation',
	'routes/admin-team.routes.ts': 'display label of the signed-in staff member',
	'utils/admin-identity.ts': 'presentation identity (name / label) of admin accounts, grants nothing',
	'services/account-management.service.ts': 'admin accounts never switch roles (restriction, not access)',
	'sockets/help-assistant-auth.ts': 'role mapping; an admin is privileged only after adminHasAnyAccess on every question',
	'services/ai/help-assistant-http.ts': 'role mapping; adminHasAnyAccess before any privileged use',
	'services/ai/waseet-ai/waseet-ai.auth.ts': 'identity label sent to the AI service; every entry point that grants admin-level data is gated (help assistant, knowledge, assistant project context)',
	'sockets/ai-review.gateway.ts': 'EXCLUDES admin accounts (providers only)',
	'sockets/ai-assistant.gateway.ts': 'EXCLUDES admin accounts (clients only)',
	'services/admin-account.service.ts': 'the audit-log list is behind audit.view; the admin-type filter only narrows what that permission shows',
	'services/admin-dashboard.service.ts': 'excludes staff from member statistics; the controller shapes the response by permission',
	'services/admin-operations.service.ts': 'lists staff for assignment (behind team.view) and builds an admin view of a project (behind the scope rule)',
	'services/admin-users.service.ts': 'refuses to change admin-type accounts from the users list (restriction)',
	'services/admin-brokers.service.ts': 'refuses to change an admin-type account from the brokers list (restriction)',
	'services/support-ticket.service.ts': 'assignee must be an admin-type account that holds support.review (assigneeHolds)',
	'services/dispute.service.ts': 'assignee must be an admin-type account that holds disputes.view (assigneeHolds)',
	'services/kyc-document-access.service.ts': 'the only caller (kyc-documents.controller) requires identity.review or specialties.approve first',
	'services/provider-profile.service.ts': 'password-change rule for admin accounts (restriction, not access)',
	'routes/knowledge.routes.ts': 'RESTRICTS: an admin-type account without access is read as a guest (adminHasAnyAccess)',
	'config/swagger.ts': 'documentation', 'dtos/account-management.dto.ts': 'validation enum',
};
test('every source file that decides by ADMIN / SUPER_ADMIN is reviewed (no unreviewed bypass around the permission system)', () => {
	const root = path.join(__dirname, '..');
	const found: string[] = [];
	const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
		const full = path.join(d, f.name);
		if (f.isDirectory()) { if (f.name !== 'node_modules') walk(full); continue; }
		if (!f.name.endsWith('.ts') || /\.(test|spec)\.ts$|testutil|pgenv/.test(f.name)) continue;
		const src = fs.readFileSync(full, 'utf8');
		if (/AccountType\.(SUPER_)?ADMIN|UserRole\.(SUPER_)?ADMIN|=== ?'(SUPER_)?ADMIN'|!== ?'(SUPER_)?ADMIN'|ADMIN_TYPES|case 'ADMIN'|isAdminAccountType|accountType: \{ in: \['ADMIN'/.test(src)) found.push(path.relative(root, full).split(path.sep).join('/'));
	} };
	walk(root);
	const unreviewed = found.filter(f => !(f in ACCOUNT_TYPE_DECISIONS));
	assert.deepEqual(unreviewed, [], `files that decide by admin account type without a review note:\n${unreviewed.join('\n')}`);
});
