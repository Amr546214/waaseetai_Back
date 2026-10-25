import { departmentsOf, isKnownPermission } from '../config/admin-permissions';
import { AccountType, AdminStaffStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { AppError, fieldError } from '../utils/app-error';
import { writeAccessAudit } from './admin-roles.service';
import { computeEffectivePermissions } from './admin-access.service';
import { ADMIN_DEPARTMENT_KEYS, ADMIN_PERMISSIONS, isKnownDepartment } from '../config/admin-permissions';
import { disconnectAdminSockets } from '../utils/socket-registry';

export const STAFF_VERSION_CONFLICT = 'STAFF_VERSION_CONFLICT';
const OPEN_TASK = ['NEW', 'IN_PROGRESS', 'PENDING'] as const;

/** "Active now": the member's newest live-session activity is at most this old (sessions refresh at most once a minute). */
export const ACTIVE_NOW_MS = 5 * 60_000;

export class AdminStaffService {
	constructor(private db: typeof defaultPrisma = defaultPrisma, private now: () => Date = () => new Date()) {}

	/** The team manages ADMIN accounts only. A SUPER_ADMIN account is never a staff member: it cannot be placed, re-roled, narrowed or suspended through the team routes. */
	private async assertStaffTarget(userId: string) {
		const u = await this.db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		if (u?.accountType === AccountType.SUPER_ADMIN) throw new AppError('حساب Super Admin لا يُدار كموظف من فريق الإدارة.', 403, undefined, 'SUPER_ADMIN_NOT_STAFF');
	}

	async list(q: { search?: string; roleId?: string; status?: string; tab?: string }) {
		const where: Prisma.AdminStaffWhereInput = {};
		if (q.roleId) where.roleId = q.roleId;
		if (q.status === 'ACTIVE' || q.status === 'SUSPENDED') where.status = q.status as AdminStaffStatus;
		if (q.tab && q.tab !== 'all' && q.tab !== 'pending') where.roleId = q.tab; // a tab is a role id
		if (q.search?.trim()) { const s = q.search.trim(); where.user = { OR: [{ firstName: { contains: s, mode: 'insensitive' } }, { lastName: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }] }; }
		const now = this.now();
		const [staff, invites, openByUser, lateByUser, doneByUser, totals] = await Promise.all([
			this.db.adminStaff.findMany({ where, orderBy: { joinedAt: 'asc' }, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, lastActiveAt: true, status: true } }, role: { select: { id: true, name: true, color: true, permissions: true } }, overrides: { select: { permission: true, effect: true } } } }),
			this.db.adminInvite.findMany({ where: { status: 'PENDING', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, include: { role: { select: { name: true } } } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: { in: [...OPEN_TASK] }, assigneeId: { not: null } }, _count: { _all: true } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: { in: [...OPEN_TASK] }, assigneeId: { not: null }, dueAt: { lt: now } }, _count: { _all: true } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: 'DONE', assigneeId: { not: null } }, _count: { _all: true } }),
			this.db.adminStaff.groupBy({ by: ['status'], _count: { _all: true } }),
		]);
		// presence = the newest authenticated activity of a live (not revoked, not expired) session; "active now" means within ACTIVE_NOW_MS. No session = no claim.
		const sessions = await this.db.userSession.groupBy({ by: ['userId'], where: { userId: { in: staff.map(s => s.userId) }, revokedAt: null, expiresAt: { gt: now } }, _max: { lastActiveAt: true } });
		const seen = new Map(sessions.map(r => [r.userId, r._max.lastActiveAt]));
		const ids = staff.map(x => x.userId);
		const [resolved, doneRows, logins] = await Promise.all([
			this.db.dispute.groupBy({ by: ['resolvedById'], where: { resolvedById: { in: ids } }, _count: { _all: true } }),
			this.db.adminTask.findMany({ where: { status: 'DONE', completedAt: { not: null }, assigneeId: { in: ids } }, select: { assigneeId: true, createdAt: true, completedAt: true } }),
			this.db.userSession.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _max: { createdAt: true } }),
		]);
		const resolvedBy = new Map(resolved.map(r => [r.resolvedById, r._count._all]));
		const hours = new Map<string, number[]>();
		for (const t of doneRows) { const l = hours.get(t.assigneeId!) ?? []; l.push(t.completedAt!.getTime() - t.createdAt.getTime()); hours.set(t.assigneeId!, l); }
		const lastLogin = new Map(logins.map(r => [r.userId, r._max.createdAt]));
		const m = (rows: Array<{ assigneeId: string | null; _count: { _all: number } }>) => new Map(rows.map(r => [r.assigneeId, r._count._all]));
		const open = m(openByUser), late = m(lateByUser), done = m(doneByUser);
		const members = staff.map(s => ({
			userId: s.userId, name: `${s.user.firstName} ${s.user.lastName}`.trim(), email: s.user.email, status: s.status,
			role: s.role ? { id: s.role.id, name: s.role.name, color: s.role.color } : null, departments: s.role ? departmentsOf([...computeEffectivePermissions(s.role.permissions, s.overrides, s.scoped, s.departments)]) : [], scoped: s.scoped, sections: s.scoped ? s.departments : null, personalChanges: s.overrides.length, joinedAt: s.joinedAt, lastActiveAt: seen.get(s.userId) ?? null, activeNow: s.status === 'ACTIVE' && !!seen.get(s.userId) && now.getTime() - seen.get(s.userId)!.getTime() <= ACTIVE_NOW_MS, version: s.version,
			resolvedDisputes: resolvedBy.get(s.userId) ?? 0, lastLoginAt: lastLogin.get(s.userId) ?? null,
			avgCompletionHours: hours.get(s.userId)?.length ? Math.round(hours.get(s.userId)!.reduce((x, y) => x + y, 0) / hours.get(s.userId)!.length / 360_000) / 10 : null,
			openTasks: open.get(s.userId) ?? 0, overdueTasks: late.get(s.userId) ?? 0, doneTasks: done.get(s.userId) ?? 0,
		}));
		const activeIds = (await this.db.adminStaff.findMany({ where: { status: 'ACTIVE' }, select: { userId: true } })).map(r => r.userId);
		const activeNow = (await this.db.userSession.groupBy({ by: ['userId'], where: { userId: { in: activeIds }, revokedAt: null, expiresAt: { gt: now }, lastActiveAt: { gte: new Date(now.getTime() - ACTIVE_NOW_MS) } } })).length;
		const active = totals.find(t => t.status === 'ACTIVE')?._count._all ?? 0, suspended = totals.find(t => t.status === 'SUSPENDED')?._count._all ?? 0;
		const openTotal = [...open.values()].reduce((a, b) => a + b, 0), lateTotal = [...late.values()].reduce((a, b) => a + b, 0);
		return {
			members: q.tab === 'pending' ? [] : members,
			pendingInvites: invites.map(i => ({ id: i.id, email: i.email, fullName: i.fullName, roleName: i.role.name, expiresAt: i.expiresAt, createdAt: i.createdAt, resendCount: i.resendCount })),
			counts: { total: active + suspended, activeNow, active, suspended, pendingInvites: invites.length, openTasks: openTotal, overdueTasks: lateTotal },
		};
	}

	/** The member's recent recorded task activity (what they created, reassigned, moved). Real events only; the caller's right to see them is checked by the route. */
	async activity(userId: string, limit = 30) {
		const rows = await this.db.adminTaskEvent.findMany({ where: { actorId: userId }, orderBy: { at: 'desc' }, take: Math.min(Math.max(limit, 1), 50), include: { task: { select: { number: true, title: true } } } });
		return rows.map(r => ({ id: r.id, at: r.at, kind: r.kind, from: r.fromValue, to: r.toValue, taskNumber: r.task.number, taskTitle: r.task.title }));
	}

	async setRole(actorId: string, userId: string, roleId: string | null, expectedVersion: unknown) {
		if (!Number.isInteger(expectedVersion)) throw fieldError('expectedVersion', 'رقم النسخة مطلوب');
		await this.assertStaffTarget(userId);
		if (roleId) { const r = await this.db.adminRole.findUnique({ where: { id: roleId }, select: { id: true } }); if (!r) throw fieldError('roleId', 'الدور غير موجود', 404); }
		const out = await this.db.$transaction(async tx => {
			const cur = await tx.adminStaff.findUnique({ where: { userId } });
			if (!cur) throw new AppError('الموظف غير موجود في الفريق', 404);
			// a new role starts from the role itself: personal changes and the section scope of the previous arrangement are cleared (and recorded), never carried over silently
			const res = await tx.adminStaff.updateMany({ where: { userId, version: expectedVersion as number }, data: { roleId, scoped: false, departments: [], version: { increment: 1 } } });
			if (res.count === 0) throw new AppError('تغيّر هذا الموظف من جهة أخرى. أعد التحميل.', 409, undefined, STAFF_VERSION_CONFLICT);
			const cleared = await tx.adminStaffOverride.findMany({ where: { staffId: cur.id }, select: { permission: true, effect: true } });
			await tx.adminStaffOverride.deleteMany({ where: { staffId: cur.id } });
			await writeAccessAudit(tx, { actorId, action: 'STAFF_ROLE_SET', subjectUserId: userId, before: { roleId: cur.roleId, personal: cleared, scoped: cur.scoped, departments: cur.departments }, after: { roleId } });
			return tx.adminStaff.findUniqueOrThrow({ where: { userId } });
		});
		void disconnectAdminSockets([userId]);
		return out;
	}

	async setStatus(actorId: string, userId: string, status: AdminStaffStatus) {
		await this.assertStaffTarget(userId);
		const out = await this.db.$transaction(async tx => {
			const cur = await tx.adminStaff.findUnique({ where: { userId } });
			if (!cur) throw new AppError('الموظف غير موجود في الفريق', 404);
			if (cur.status === status) return cur;
			const row = await tx.adminStaff.update({ where: { userId }, data: { status, suspendedAt: status === 'SUSPENDED' ? this.now() : null, version: { increment: 1 } } });
			await writeAccessAudit(tx, { actorId, action: status === 'SUSPENDED' ? 'STAFF_SUSPENDED' : 'STAFF_REACTIVATED', subjectUserId: userId, before: { status: cur.status }, after: { status } });
			return row;
		});
		if (status === 'SUSPENDED') void disconnectAdminSockets([userId]);
		return out;
	}

	/** The access of one staff member as the UI needs it: what the role gives, the personal changes on top, the section scope, and the result the server actually applies. */
	async accessDetail(userId: string) {
		await this.assertStaffTarget(userId);
		const st = await this.db.adminStaff.findUnique({ where: { userId }, include: { role: { select: { id: true, name: true, permissions: true } }, overrides: { select: { permission: true, effect: true, createdAt: true } } } });
		if (!st) throw new AppError('الموظف غير موجود في الفريق', 404);
		const rolePermissions = (st.role?.permissions ?? []).filter(isKnownPermission);
		const effective = st.status === 'ACTIVE' && st.role ? [...computeEffectivePermissions(st.role.permissions, st.overrides, st.scoped, st.departments)].sort() : [];
		return {
			userId, version: st.version, status: st.status, role: st.role ? { id: st.role.id, name: st.role.name } : null, rolePermissions: [...rolePermissions].sort(),
			overrides: st.overrides.map(o => ({ permission: o.permission, effect: o.effect, at: o.createdAt })).sort((a, b) => a.permission.localeCompare(b.permission)),
			scoped: st.scoped, departments: st.departments, effective,
		};
	}

	/**
	 * Replaces the personal changes and the section scope of ONE staff member in one transaction (compare-and-set on the staff version). Rules: only a SUPER_ADMIN reaches this; ids must be in
	 * the registry (a SUPER_ADMIN-only capability is not in it, so it can never be granted); a sensitive GRANT needs explicit confirmation; a DENY beats the role; an empty list with
	 * scoped=false is the reset to the role. The previous and new state are written to the audit trail in the same transaction.
	 */
	async setAccess(actorId: string, userId: string, input: { overrides?: unknown; scoped?: unknown; departments?: unknown; expectedVersion?: unknown; confirmSensitive?: unknown }) {
		await this.assertStaffTarget(userId);
		if (!Number.isInteger(input.expectedVersion)) throw fieldError('expectedVersion', 'رقم النسخة مطلوب');
		const list = Array.isArray(input.overrides) ? input.overrides : input.overrides === undefined ? [] : null;
		if (!list || list.length > 60) throw fieldError('overrides', 'قائمة التخصيصات غير صحيحة');
		const seen = new Set<string>(); const overrides: Array<{ permission: string; effect: 'GRANT' | 'DENY' }> = [];
		for (const o of list) {
			const permission = String((o as any)?.permission ?? ''), effect = (o as any)?.effect;
			if (!isKnownPermission(permission)) throw fieldError('overrides', `صلاحية غير معروفة: ${permission.slice(0, 40)}`);
			if (effect !== 'GRANT' && effect !== 'DENY') throw fieldError('overrides', 'نوع التخصيص يجب أن يكون GRANT أو DENY');
			if (seen.has(permission)) throw fieldError('overrides', `تخصيص مكرر: ${permission}`);
			seen.add(permission); overrides.push({ permission, effect });
		}
		const scoped = input.scoped === true;
		const departments = Array.isArray(input.departments) ? [...new Set(input.departments.map(String))] : [];
		if (departments.some(d => !isKnownDepartment(d))) throw fieldError('departments', 'قسم غير معروف');
		if (scoped && departments.length === 0) throw fieldError('departments', 'اختر قسمًا واحدًا على الأقل أو ألغِ تقييد الأقسام');
		const sensitive = new Set(ADMIN_PERMISSIONS.filter(p => p.sensitive).map(p => p.id));
		const newlySensitive = overrides.filter(o => o.effect === 'GRANT' && sensitive.has(o.permission)).map(o => o.permission);
		const cur0 = await this.db.adminStaff.findUnique({ where: { userId }, include: { role: { select: { permissions: true } }, overrides: { select: { permission: true, effect: true } } } });
		if (!cur0) throw new AppError('الموظف غير موجود في الفريق', 404);
		const alreadyGranted = new Set(cur0.overrides.filter(o => o.effect === 'GRANT').map(o => o.permission)); const inRole = new Set(cur0.role?.permissions ?? []);
		const toConfirm = newlySensitive.filter(p => !alreadyGranted.has(p) && !inRole.has(p));
		if (toConfirm.length && input.confirmSensitive !== true) throw new AppError('منح صلاحية حساسة لموظف بعينه يحتاج تأكيدًا صريحًا', 409, [{ addedSensitive: toConfirm }], 'SENSITIVE_CONFIRMATION_REQUIRED');
		const out = await this.db.$transaction(async tx => {
			const res = await tx.adminStaff.updateMany({ where: { userId, version: input.expectedVersion as number }, data: { scoped, departments: scoped ? departments : [], version: { increment: 1 } } });
			if (res.count === 0) throw new AppError('تغيّر هذا الموظف من جهة أخرى. أعد التحميل وراجع التغيير.', 409, undefined, STAFF_VERSION_CONFLICT);
			await tx.adminStaffOverride.deleteMany({ where: { staffId: cur0.id } });
			if (overrides.length) await tx.adminStaffOverride.createMany({ data: overrides.map(o => ({ staffId: cur0.id, permission: o.permission, effect: o.effect, createdById: actorId })) });
			await writeAccessAudit(tx, { actorId, action: overrides.length || scoped ? 'STAFF_ACCESS_SET' : 'STAFF_ACCESS_RESET', subjectUserId: userId,
				before: { overrides: cur0.overrides, scoped: cur0.scoped, departments: cur0.departments }, after: { overrides, scoped, departments: scoped ? departments : [] } });
			return tx.adminStaff.findUniqueOrThrow({ where: { userId } });
		});
		void disconnectAdminSockets([userId]);
		return { userId, version: out.version };
	}

	/** An EXISTING admin-type account (e.g. one of today's accounts) enters the team only when a SUPER_ADMIN places it, with a role chosen by the SUPER_ADMIN. */
	async attachExisting(actorId: string, userId: string, roleId: string | null) {
		await this.assertStaffTarget(userId);
		const u = await this.db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		if (!u || u.accountType !== AccountType.ADMIN) throw fieldError('userId', 'الحساب غير موجود أو ليس حساب موظف إدارة (ADMIN)');
		if (roleId) { const r = await this.db.adminRole.findUnique({ where: { id: roleId }, select: { id: true } }); if (!r) throw fieldError('roleId', 'الدور غير موجود', 404); }
		try {
			return await this.db.$transaction(async tx => {
				const row = await tx.adminStaff.create({ data: { userId, roleId, invitedById: actorId } });
				await writeAccessAudit(tx, { actorId, action: 'STAFF_ATTACHED', subjectUserId: userId, after: { roleId } });
				return row;
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('هذا الحساب ضمن الفريق بالفعل', 409);
			throw e;
		}
	}

	/** Existing admin-type accounts that are not in the team yet (a SUPER_ADMIN picks from here; nothing is granted by being listed). */
	async unplacedAdminAccounts() {
		const rows = await this.db.user.findMany({ where: { accountType: AccountType.ADMIN, adminStaff: null }, select: { id: true, firstName: true, lastName: true, email: true, accountType: true, status: true, lastActiveAt: true }, orderBy: { createdAt: 'asc' } });
		return rows.map(r => ({ userId: r.id, name: `${r.firstName} ${r.lastName}`.trim(), email: r.email, accountType: r.accountType, status: r.status, lastActiveAt: r.lastActiveAt }));
	}
}
export const adminStaffService = new AdminStaffService();
