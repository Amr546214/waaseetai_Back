import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { authLimiter } from '../middlewares/rate-limit.middleware';
import { loadAdminActor, requireAdminAccount, requireAdminMember, requireAnyPermission, requireSuperAdmin, requirePermission } from '../middlewares/admin-access.middleware';
import { ADMIN_DEPARTMENTS, ADMIN_GROUP_LABELS, ADMIN_PERMISSIONS, ADMIN_ROLE_TEMPLATES, AMBIGUITIES, PERMISSION_DEPARTMENT, SUPER_ADMIN_ONLY_CAPABILITIES } from '../config/admin-permissions';
import { adminRolesService } from '../services/admin-roles.service';
import { adminStaffService } from '../services/admin-staff.service';
import { adminInvitesService } from '../services/admin-invites.service';
import { adminTasksService, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from '../services/admin-tasks.service';
import { adminPerformanceService } from '../services/admin-performance.service';
import { prisma } from '../config/db';
import { AppError, fieldError } from '../utils/app-error';

/**
 * /api/admin/team - the admin team: who I am, roles and permissions (SUPER_ADMIN only), staff, invitations, tasks, performance, the access audit trail.
 * Every handler picks the fields it accepts by name (no body is ever spread into a database write: a request cannot smuggle a role, a status or a SUPER_ADMIN flag in).
 */
const router = Router();
const publicInvites = Router();
export { publicInvites as adminInvitePublicRouter };

const ok = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.status(status).json({ success: true, data: await fn(req) }); } catch (e) { next(e); }
};
const only = (body: any, allowed: string[]) => {
	const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
	const extra = Object.keys(b).filter(k => !allowed.includes(k));
	if (extra.length) throw fieldError(extra[0], 'حقل غير مسموح');
	return b;
};
const id = (req: Request) => String(req.params.id);

router.use(authenticate, requireActiveUser);

// --- who am I (any admin-type account, even one with no permission: it must be able to see WHY it sees nothing) ---
router.get('/access/me', requireAdminAccount, ok(async req => {
	const a = await loadAdminActor(req);
	const staff = a.isSuperAdmin || !a.staffId ? null : await prisma.adminStaff.findUnique({ where: { userId: a.userId }, select: { scoped: true, departments: true } });
	return {
		userId: a.userId, isSuperAdmin: a.isSuperAdmin, staffStatus: a.staffStatus, roleName: a.roleName, permissions: [...a.permissions].sort(),
		hasAnyPermission: a.isSuperAdmin || a.permissions.size > 0,
		state: a.isSuperAdmin ? 'SUPER_ADMIN' : a.staffStatus === 'SUSPENDED' ? 'SUSPENDED' : !a.staffId ? 'NOT_IN_TEAM' : a.permissions.size === 0 ? 'NO_PERMISSIONS' : 'ACTIVE',
		displayRole: a.isSuperAdmin ? 'مدير النظام' : a.roleName ?? 'غير مُسند',
		sections: staff?.scoped ? staff.departments : null,
	};
}));

// --- registry (SUPER_ADMIN) ---
router.get('/permissions', requireSuperAdmin, ok(async () => ({
	superAdminCount: await prisma.user.count({ where: { accountType: 'SUPER_ADMIN', status: 'ACTIVE', isBanned: false } }),
	permissions: ADMIN_PERMISSIONS, departments: ADMIN_DEPARTMENTS, permissionDepartment: PERMISSION_DEPARTMENT, groups: ADMIN_GROUP_LABELS, templates: ADMIN_ROLE_TEMPLATES, superAdminOnly: SUPER_ADMIN_ONLY_CAPABILITIES, ambiguities: AMBIGUITIES,
})));

// --- roles (SUPER_ADMIN only) ---
router.get('/roles', requireSuperAdmin, ok(() => adminRolesService.list()));
router.post('/roles', requireSuperAdmin, ok(req => adminRolesService.create(req.user!.id, only(req.body, ['name', 'description', 'color', 'permissions'])), 201));
router.post('/roles/:id/preview', requireSuperAdmin, ok(req => adminRolesService.preview(id(req), only(req.body, ['permissions']).permissions)));
router.patch('/roles/:id', requireSuperAdmin, ok(req => adminRolesService.update(req.user!.id, id(req), only(req.body, ['name', 'description', 'color', 'permissions', 'expectedVersion', 'confirmSensitive']))));

// --- staff ---
router.get('/staff', requirePermission('team.view'), ok(req => adminStaffService.list({ search: String(req.query.search ?? ''), roleId: req.query.roleId ? String(req.query.roleId) : undefined, status: req.query.status ? String(req.query.status) : undefined, tab: req.query.tab ? String(req.query.tab) : undefined })));
router.get('/staff/unplaced', requireSuperAdmin, ok(() => adminStaffService.unplacedAdminAccounts()));
router.get('/staff/:id/activity', requireAdminMember, ok(async req => {
	const actor = await loadAdminActor(req);
	if (!actor.isSuperAdmin && actor.userId !== id(req) && !actor.permissions.has('tasks.manage')) throw new AppError('ليست لديك صلاحية تنفيذ هذا الإجراء.', 403, undefined, 'ADMIN_PERMISSION_DENIED');
	return adminStaffService.activity(id(req));
}));
router.post('/staff/attach', requireSuperAdmin, ok(req => { const b = only(req.body, ['userId', 'roleId']); return adminStaffService.attachExisting(req.user!.id, String(b.userId ?? ''), b.roleId ? String(b.roleId) : null); }, 201));
router.patch('/staff/:id/role', requireSuperAdmin, ok(req => { const b = only(req.body, ['roleId', 'expectedVersion']); return adminStaffService.setRole(req.user!.id, id(req), b.roleId ? String(b.roleId) : null, b.expectedVersion); }));
router.get('/staff/:id/access', requireSuperAdmin, ok(req => adminStaffService.accessDetail(id(req))));
router.put('/staff/:id/access', requireSuperAdmin, ok(req => adminStaffService.setAccess(req.user!.id, id(req), only(req.body, ['overrides', 'scoped', 'departments', 'expectedVersion', 'confirmSensitive']))));
router.post('/staff/:id/suspend', requireSuperAdmin, ok(req => adminStaffService.setStatus(req.user!.id, id(req), 'SUSPENDED')));
router.post('/staff/:id/reactivate', requireSuperAdmin, ok(req => adminStaffService.setStatus(req.user!.id, id(req), 'ACTIVE')));

// --- invitations (SUPER_ADMIN only; the public acceptance is mounted separately) ---
router.post('/invites', requireSuperAdmin, ok(req => adminInvitesService.create(req.user!.id, only(req.body, ['email', 'fullName', 'roleId', 'departments'])), 201));
router.post('/invites/:id/resend', requireSuperAdmin, ok(req => adminInvitesService.resend(req.user!.id, id(req))));
router.post('/invites/:id/cancel', requireSuperAdmin, ok(req => adminInvitesService.cancel(req.user!.id, id(req))));

// --- tasks ---
router.get('/tasks/meta', requireAdminMember, ok(async () => ({ statuses: TASK_STATUSES, priorities: TASK_PRIORITIES, types: TASK_TYPES })));
router.get('/tasks/summary', requireAdminMember, ok(async req => adminTasksService.summary(await loadAdminActor(req))));
router.get('/tasks', requireAdminMember, ok(async req => adminTasksService.list(await loadAdminActor(req), { tab: String(req.query.tab ?? ''), assigneeId: req.query.assigneeId ? String(req.query.assigneeId) : undefined, type: req.query.type ? String(req.query.type) : undefined, search: String(req.query.search ?? '') })));
router.post('/tasks', requirePermission('tasks.manage'), ok(async req => adminTasksService.create(await loadAdminActor(req), only(req.body, ['title', 'description', 'type', 'priority', 'dueAt', 'assigneeId', 'linkType', 'linkId'])), 201));
router.get('/tasks/:id', requireAdminMember, ok(async req => adminTasksService.get(await loadAdminActor(req), id(req))));
router.patch('/tasks/:id', requirePermission('tasks.manage'), ok(async req => adminTasksService.update(await loadAdminActor(req), id(req), only(req.body, ['title', 'description', 'priority', 'dueAt', 'assigneeId', 'expectedVersion']))));
router.post('/tasks/:id/status', requireAdminMember, ok(async req => { const b = only(req.body, ['status', 'expectedVersion']); return adminTasksService.setStatus(await loadAdminActor(req), id(req), b.status, b.expectedVersion); }));

// --- performance (the export uses the same data and needs BOTH permissions) ---
router.get('/performance', requirePermission('performance.view'), ok(req => adminPerformanceService.report(req.query.period)));
router.get('/performance/export', requirePermission('performance.view', 'performance.export'), async (req, res, next) => {
	try {
		const csv = await adminPerformanceService.exportCsv(req.query.period);
		res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="team-performance.csv"'); res.setHeader('Cache-Control', 'no-store');
		res.status(200).send(csv);
	} catch (e) { next(e); }
});

// --- who granted what to whom (audit.view; a SUPER_ADMIN holds it) ---
router.get('/access-audit', requirePermission('audit.view'), ok(async req => {
	const take = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
	const rows = await prisma.adminAccessAudit.findMany({ orderBy: { at: 'desc' }, take });
	const ids = Array.from(new Set(rows.flatMap(r => [r.actorId, r.subjectUserId].filter(Boolean) as string[])));
	const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
	const name = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
	return rows.map(r => ({ id: r.id, at: r.at, action: r.action, actor: name.get(r.actorId) ?? null, subject: r.subjectUserId ? name.get(r.subjectUserId) ?? null : null, roleId: r.roleId, before: r.before, after: r.after }));
}));

// --- public acceptance of an invitation (no login; one-time token; rate limited) ---
publicInvites.use(authLimiter);
// every public step takes the token in the BODY (never in the URL or query string, which access logs record)
publicInvites.post('/preview', ok(req => adminInvitesService.preview(only(req.body, ['token']).token)));
publicInvites.post('/request-code', ok(req => adminInvitesService.requestCode(only(req.body, ['token']).token)));
publicInvites.post('/accept', ok(req => { const b = only(req.body, ['token', 'password', 'code']); return adminInvitesService.accept(b.token, b); }));
void AppError; void requireAnyPermission;

export default router;
