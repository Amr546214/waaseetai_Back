import { AccountType, AdminStaffStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { AppError, fieldError } from '../utils/app-error';
import { writeAccessAudit } from './admin-roles.service';

export const STAFF_VERSION_CONFLICT = 'STAFF_VERSION_CONFLICT';
const OPEN_TASK = ['NEW', 'IN_PROGRESS', 'PENDING'] as const;

export class AdminStaffService {
	constructor(private db: typeof defaultPrisma = defaultPrisma, private now: () => Date = () => new Date()) {}

	private async assertNotOwner(userId: string) {
		if (await this.db.platformOwner.findUnique({ where: { userId } })) throw new AppError('لا يمكن تغيير سلطة المالك أو إيقافه من هنا.', 403, undefined, 'OWNER_PROTECTED');
	}

	async list(q: { search?: string; roleId?: string; status?: string; tab?: string }) {
		const where: Prisma.AdminStaffWhereInput = {};
		if (q.roleId) where.roleId = q.roleId;
		if (q.status === 'ACTIVE' || q.status === 'SUSPENDED') where.status = q.status as AdminStaffStatus;
		if (q.tab && q.tab !== 'all' && q.tab !== 'pending') where.roleId = q.tab; // a tab is a role id
		if (q.search?.trim()) { const s = q.search.trim(); where.user = { OR: [{ firstName: { contains: s, mode: 'insensitive' } }, { lastName: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }] }; }
		const now = this.now();
		const [staff, owner, invites, openByUser, lateByUser, doneByUser, totals] = await Promise.all([
			this.db.adminStaff.findMany({ where, orderBy: { joinedAt: 'asc' }, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, lastActiveAt: true, status: true } }, role: { select: { id: true, name: true, color: true } } } }),
			this.db.platformOwner.findFirst({ select: { userId: true } }),
			this.db.adminInvite.findMany({ where: { status: 'PENDING', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, include: { role: { select: { name: true } } } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: { in: [...OPEN_TASK] }, assigneeId: { not: null } }, _count: { _all: true } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: { in: [...OPEN_TASK] }, assigneeId: { not: null }, dueAt: { lt: now } }, _count: { _all: true } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: 'DONE', assigneeId: { not: null } }, _count: { _all: true } }),
			this.db.adminStaff.groupBy({ by: ['status'], _count: { _all: true } }),
		]);
		const m = (rows: Array<{ assigneeId: string | null; _count: { _all: number } }>) => new Map(rows.map(r => [r.assigneeId, r._count._all]));
		const open = m(openByUser), late = m(lateByUser), done = m(doneByUser);
		const members = staff.map(s => ({
			userId: s.userId, name: `${s.user.firstName} ${s.user.lastName}`.trim(), email: s.user.email, status: s.status, isOwner: owner?.userId === s.userId,
			role: s.role ? { id: s.role.id, name: s.role.name, color: s.role.color } : null, joinedAt: s.joinedAt, lastActiveAt: s.user.lastActiveAt, version: s.version,
			openTasks: open.get(s.userId) ?? 0, overdueTasks: late.get(s.userId) ?? 0, doneTasks: done.get(s.userId) ?? 0,
		}));
		const active = totals.find(t => t.status === 'ACTIVE')?._count._all ?? 0, suspended = totals.find(t => t.status === 'SUSPENDED')?._count._all ?? 0;
		const openTotal = [...open.values()].reduce((a, b) => a + b, 0), lateTotal = [...late.values()].reduce((a, b) => a + b, 0);
		return {
			members: q.tab === 'pending' ? [] : members,
			pendingInvites: invites.map(i => ({ id: i.id, email: i.email, fullName: i.fullName, roleName: i.role.name, expiresAt: i.expiresAt, createdAt: i.createdAt, resendCount: i.resendCount })),
			counts: { total: active + suspended, active, suspended, pendingInvites: invites.length, openTasks: openTotal, overdueTasks: lateTotal },
		};
	}

	async setRole(actorId: string, userId: string, roleId: string | null, expectedVersion: unknown) {
		if (!Number.isInteger(expectedVersion)) throw fieldError('expectedVersion', 'رقم النسخة مطلوب');
		await this.assertNotOwner(userId);
		if (roleId) { const r = await this.db.adminRole.findUnique({ where: { id: roleId }, select: { id: true } }); if (!r) throw fieldError('roleId', 'الدور غير موجود', 404); }
		return this.db.$transaction(async tx => {
			const cur = await tx.adminStaff.findUnique({ where: { userId } });
			if (!cur) throw new AppError('الموظف غير موجود في الفريق', 404);
			const res = await tx.adminStaff.updateMany({ where: { userId, version: expectedVersion as number }, data: { roleId, version: { increment: 1 } } });
			if (res.count === 0) throw new AppError('تغيّر هذا الموظف من جهة أخرى. أعد التحميل.', 409, undefined, STAFF_VERSION_CONFLICT);
			await writeAccessAudit(tx, { actorId, action: 'STAFF_ROLE_SET', subjectUserId: userId, before: { roleId: cur.roleId }, after: { roleId } });
			return tx.adminStaff.findUniqueOrThrow({ where: { userId } });
		});
	}

	async setStatus(actorId: string, userId: string, status: AdminStaffStatus) {
		await this.assertNotOwner(userId);
		return this.db.$transaction(async tx => {
			const cur = await tx.adminStaff.findUnique({ where: { userId } });
			if (!cur) throw new AppError('الموظف غير موجود في الفريق', 404);
			if (cur.status === status) return cur;
			const row = await tx.adminStaff.update({ where: { userId }, data: { status, suspendedAt: status === 'SUSPENDED' ? this.now() : null, version: { increment: 1 } } });
			await writeAccessAudit(tx, { actorId, action: status === 'SUSPENDED' ? 'STAFF_SUSPENDED' : 'STAFF_REACTIVATED', subjectUserId: userId, before: { status: cur.status }, after: { status } });
			return row;
		});
	}

	/** An EXISTING admin-type account (e.g. one of today's accounts) enters the team only when the owner places it, with a role chosen by the owner. */
	async attachExisting(actorId: string, userId: string, roleId: string | null) {
		await this.assertNotOwner(userId);
		const u = await this.db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		if (!u || (u.accountType !== AccountType.ADMIN && u.accountType !== AccountType.SUPER_ADMIN)) throw fieldError('userId', 'الحساب غير موجود أو ليس حساب إدارة');
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

	/** Existing admin-type accounts that are not in the team yet (the owner picks from here; nothing is granted by being listed). */
	async unplacedAdminAccounts() {
		const rows = await this.db.user.findMany({ where: { accountType: { in: [AccountType.ADMIN, AccountType.SUPER_ADMIN] }, adminStaff: null, platformOwner: null }, select: { id: true, firstName: true, lastName: true, email: true, accountType: true, status: true, lastActiveAt: true }, orderBy: { createdAt: 'asc' } });
		return rows.map(r => ({ userId: r.id, name: `${r.firstName} ${r.lastName}`.trim(), email: r.email, accountType: r.accountType, status: r.status, lastActiveAt: r.lastActiveAt }));
	}
}
export const adminStaffService = new AdminStaffService();
