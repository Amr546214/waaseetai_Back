import { AdminTaskPriority, AdminTaskStatus, AdminTaskType, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { AppError, fieldError } from '../utils/app-error';
import { AdminActor, actorHas, assigneeHolds } from './admin-access.service';

export const TASK_VERSION_CONFLICT = 'TASK_VERSION_CONFLICT';
const OPEN: AdminTaskStatus[] = ['NEW', 'IN_PROGRESS', 'PENDING'];
/** The permission a person needs to do the work of a task type. Assigning never grants it: the assignee must already hold it. */
export const TASK_TYPE_PERMISSION: Record<AdminTaskType, string[]> = {
	DISPUTE: ['disputes.view'], REPORT: ['reports.view'], SUPPORT: ['support.review'], APPROVAL: [], FINANCE: ['finance.read'], DOCUMENT: ['performance.view'],
};
/** Linking a task to a ticket / dispute needs the permission to open that item, so a task can never be a way around it. */
const LINK_PERMISSION: Record<string, string> = { TICKET: 'support.review', DISPUTE: 'disputes.view' };
const APPROVAL_ANY = ['identity.review', 'specialties.approve', 'business_models.review'];

const enumOf = <T extends string>(v: unknown, all: readonly T[], field: string, msg: string): T => {
	if (!all.includes(v as T)) throw fieldError(field, msg);
	return v as T;
};
export const TASK_STATUSES: readonly AdminTaskStatus[] = ['NEW', 'IN_PROGRESS', 'PENDING', 'DONE', 'CANCELLED'];
export const TASK_PRIORITIES: readonly AdminTaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'NORMAL', 'LOW'];
export const TASK_TYPES: readonly AdminTaskType[] = ['DISPUTE', 'REPORT', 'SUPPORT', 'APPROVAL', 'FINANCE', 'DOCUMENT'];

export class AdminTasksService {
	constructor(private db: typeof defaultPrisma = defaultPrisma, private now: () => Date = () => new Date()) {}

	/** What this actor may see: the whole team's tasks with tasks.manage (the scope the owner granted), otherwise only their own. */
	private scope(actor: AdminActor): Prisma.AdminTaskWhereInput { return actorHas(actor, 'tasks.manage') ? {} : { assigneeId: actor.userId }; }

	private async assigneeOk(assigneeId: string, type: AdminTaskType) {
		const need = TASK_TYPE_PERMISSION[type];
		if (type === 'APPROVAL') {
			for (const id of APPROVAL_ANY) if (await assigneeHolds(assigneeId, [id], this.db)) return;
			throw fieldError('assigneeId', 'الموظف المكلَّف لا يملك صلاحية المراجعة اللازمة لهذه المهمة');
		}
		if (need.length && !(await assigneeHolds(assigneeId, need, this.db))) throw fieldError('assigneeId', 'الموظف المكلَّف لا يملك الصلاحية اللازمة لهذا النوع من المهام. التكليف لا يمنح صلاحية جديدة.');
		if (!need.length && !(await this.db.adminStaff.findFirst({ where: { userId: assigneeId, status: 'ACTIVE' } }))) throw fieldError('assigneeId', 'الموظف المكلَّف ليس عضوًا نشطًا في الفريق');
	}

	async create(actor: AdminActor, input: any) {
		const title = String(input.title ?? '').trim();
		if (title.length < 3 || title.length > 200) throw fieldError('title', 'عنوان المهمة مطلوب (3 إلى 200 حرف)');
		const type = enumOf(input.type, TASK_TYPES, 'type', 'نوع المهمة غير صالح');
		const priority = input.priority === undefined ? 'NORMAL' as AdminTaskPriority : enumOf(input.priority, TASK_PRIORITIES, 'priority', 'الأولوية غير صالحة');
		let dueAt: Date | null = null;
		if (input.dueAt) { dueAt = new Date(String(input.dueAt)); if (Number.isNaN(dueAt.getTime())) throw fieldError('dueAt', 'الموعد غير صالح'); }
		const assigneeId = input.assigneeId ? String(input.assigneeId) : null;
		if (assigneeId) await this.assigneeOk(assigneeId, type);
		let linkType: string | null = null, linkId: string | null = null;
		if (input.linkType) {
			linkType = enumOf(String(input.linkType), ['TICKET', 'DISPUTE'] as const, 'linkType', 'نوع الربط غير صالح');
			linkId = String(input.linkId ?? '').slice(0, 64);
			if (!linkId) throw fieldError('linkId', 'معرّف العنصر المرتبط مطلوب');
			if (!actorHas(actor, LINK_PERMISSION[linkType])) throw new AppError('ليست لديك صلاحية فتح العنصر الذي تربط به المهمة.', 403, undefined, 'ADMIN_PERMISSION_DENIED');
			if (assigneeId && !(await assigneeHolds(assigneeId, [LINK_PERMISSION[linkType]], this.db))) throw fieldError('assigneeId', 'الموظف المكلَّف لا يملك صلاحية فتح العنصر المرتبط');
		}
		return this.db.$transaction(async tx => {
			const t = await tx.adminTask.create({ data: { title, description: input.description ? String(input.description).slice(0, 2000) : null, type, priority, dueAt, assigneeId, createdById: actor.userId, linkType, linkId } });
			await tx.adminTaskEvent.create({ data: { taskId: t.id, actorId: actor.userId, kind: 'CREATED', toValue: assigneeId } });
			return t;
		});
	}

	async list(actor: AdminActor, q: { tab?: string; assigneeId?: string; type?: string; search?: string }) {
		const now = this.now();
		const where: Prisma.AdminTaskWhereInput = { ...this.scope(actor) };
		if (q.tab === 'open') where.status = 'IN_PROGRESS'; else if (q.tab === 'pending') where.status = { in: ['NEW', 'PENDING'] }; else if (q.tab === 'done') where.status = 'DONE';
		if (q.assigneeId) where.assigneeId = q.assigneeId;
		if (q.type && (TASK_TYPES as readonly string[]).includes(q.type)) where.type = q.type as AdminTaskType;
		if (q.search?.trim()) where.title = { contains: q.search.trim(), mode: 'insensitive' };
		const rows = await this.db.adminTask.findMany({ where, orderBy: [{ priority: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }], take: 200, include: { assignee: { select: { user: { select: { id: true, firstName: true, lastName: true } } } } } });
		return rows.map(t => this.view(t, now));
	}

	async summary(actor: AdminActor) {
		const now = this.now(), scope = this.scope(actor);
		const [byStatus, overdue, doneMonth] = await Promise.all([
			this.db.adminTask.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
			this.db.adminTask.count({ where: { ...scope, status: { in: OPEN }, dueAt: { lt: now } } }),
			this.db.adminTask.findMany({ where: { ...scope, status: 'DONE', completedAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) } }, select: { dueAt: true, completedAt: true, createdAt: true } }),
		]);
		const n = (s: AdminTaskStatus) => byStatus.find(b => b.status === s)?._count._all ?? 0;
		const withDue = doneMonth.filter(t => t.dueAt && t.completedAt);
		const onTime = withDue.filter(t => t.completedAt! <= t.dueAt!).length;
		return {
			byStatus: { NEW: n('NEW'), IN_PROGRESS: n('IN_PROGRESS'), PENDING: n('PENDING'), DONE: n('DONE'), CANCELLED: n('CANCELLED'), OVERDUE: overdue },
			open: n('NEW') + n('IN_PROGRESS') + n('PENDING'), inProgress: n('IN_PROGRESS'), pending: n('PENDING') + n('NEW'), overdue, doneThisMonth: doneMonth.length,
			onTimeThisMonth: withDue.length ? { onTime, of: withDue.length } : null,
			avgCompletionHoursThisMonth: doneMonth.length ? Math.round((doneMonth.reduce((a, t) => a + (t.completedAt!.getTime() - t.createdAt.getTime()), 0) / doneMonth.length / 3600_000) * 10) / 10 : null,
		};
	}

	async get(actor: AdminActor, id: string) {
		const t = await this.db.adminTask.findFirst({ where: { id, ...this.scope(actor) }, include: { assignee: { select: { user: { select: { id: true, firstName: true, lastName: true } } } }, events: { orderBy: { at: 'asc' } } } });
		if (!t) throw new AppError('المهمة غير موجودة', 404);
		return { ...this.view(t, this.now()), events: t.events.map(e => ({ kind: e.kind, from: e.fromValue, to: e.toValue, at: e.at, actorId: e.actorId })) };
	}

	/** Assign / reassign / edit: tasks.manage only. */
	async update(actor: AdminActor, id: string, input: any) {
		if (!Number.isInteger(input.expectedVersion)) throw fieldError('expectedVersion', 'رقم نسخة المهمة مطلوب');
		const cur = await this.db.adminTask.findUnique({ where: { id } });
		if (!cur) throw new AppError('المهمة غير موجودة', 404);
		const data: Prisma.AdminTaskUpdateManyMutationInput & { assigneeId?: string | null } = {};
		if (input.title !== undefined) { const t = String(input.title).trim(); if (t.length < 3 || t.length > 200) throw fieldError('title', 'عنوان المهمة مطلوب'); data.title = t; }
		if (input.description !== undefined) data.description = input.description ? String(input.description).slice(0, 2000) : null;
		if (input.priority !== undefined) data.priority = enumOf(input.priority, TASK_PRIORITIES, 'priority', 'الأولوية غير صالحة');
		if (input.dueAt !== undefined) { if (input.dueAt === null) data.dueAt = null; else { const d = new Date(String(input.dueAt)); if (Number.isNaN(d.getTime())) throw fieldError('dueAt', 'الموعد غير صالح'); data.dueAt = d; } }
		let reassigned = false;
		if (input.assigneeId !== undefined) {
			if (input.assigneeId) {
				await this.assigneeOk(String(input.assigneeId), cur.type);
				if (cur.linkType && !(await assigneeHolds(String(input.assigneeId), [LINK_PERMISSION[cur.linkType]], this.db))) throw fieldError('assigneeId', 'الموظف المكلَّف لا يملك صلاحية فتح العنصر المرتبط');
			}
			data.assigneeId = input.assigneeId ? String(input.assigneeId) : null; reassigned = data.assigneeId !== cur.assigneeId;
		}
		return this.db.$transaction(async tx => {
			const { assigneeId, ...rest } = data;
			const res = await tx.adminTask.updateMany({ where: { id, version: input.expectedVersion }, data: { ...rest, ...(assigneeId !== undefined ? { assigneeId } : {}), version: { increment: 1 } } });
			if (res.count === 0) throw new AppError('عُدّلت هذه المهمة من جهة أخرى. أعد التحميل.', 409, undefined, TASK_VERSION_CONFLICT);
			await tx.adminTaskEvent.create({ data: { taskId: id, actorId: actor.userId, kind: reassigned ? 'ASSIGNED' : 'EDITED', fromValue: cur.assigneeId, toValue: data.assigneeId ?? cur.assigneeId } });
			return tx.adminTask.findUniqueOrThrow({ where: { id } });
		});
	}

	/** Status change: tasks.manage on any task, or the assignee on THEIR OWN task (no other permission is needed to report progress on your own work). */
	async setStatus(actor: AdminActor, id: string, statusRaw: unknown, expectedVersion: unknown) {
		const status = enumOf(statusRaw, TASK_STATUSES, 'status', 'الحالة غير صالحة');
		if (!Number.isInteger(expectedVersion)) throw fieldError('expectedVersion', 'رقم نسخة المهمة مطلوب');
		const cur = await this.db.adminTask.findUnique({ where: { id } });
		if (!cur) throw new AppError('المهمة غير موجودة', 404);
		const mine = cur.assigneeId === actor.userId;
		if (!mine && !actorHas(actor, 'tasks.manage')) throw new AppError('لا يمكنك تغيير حالة مهمة غير مكلَّف بها.', 403, undefined, 'ADMIN_PERMISSION_DENIED');
		if (mine && !actorHas(actor, 'tasks.manage') && status === 'CANCELLED') throw new AppError('إلغاء المهمة لمن يديرها فقط.', 403, undefined, 'ADMIN_PERMISSION_DENIED');
		const now = this.now();
		return this.db.$transaction(async tx => {
			const res = await tx.adminTask.updateMany({ where: { id, version: expectedVersion as number }, data: { status, version: { increment: 1 }, startedAt: status === 'IN_PROGRESS' && !cur.startedAt ? now : undefined, completedAt: status === 'DONE' ? now : status === 'CANCELLED' ? null : cur.status === 'DONE' ? null : undefined } });
			if (res.count === 0) throw new AppError('عُدّلت هذه المهمة من جهة أخرى. أعد التحميل.', 409, undefined, TASK_VERSION_CONFLICT);
			await tx.adminTaskEvent.create({ data: { taskId: id, actorId: actor.userId, kind: 'STATUS', fromValue: cur.status, toValue: status } });
			return tx.adminTask.findUniqueOrThrow({ where: { id } });
		});
	}

	private view(t: any, now: Date) {
		const open = OPEN.includes(t.status);
		return {
			id: t.id, number: t.number, code: `T-${String(t.number).padStart(4, '0')}`, title: t.title, description: t.description, type: t.type, priority: t.priority, status: t.status,
			overdue: !!(open && t.dueAt && t.dueAt < now), dueAt: t.dueAt, completedAt: t.completedAt, version: t.version, createdAt: t.createdAt,
			assignee: t.assignee?.user ? { id: t.assignee.user.id, name: `${t.assignee.user.firstName} ${t.assignee.user.lastName}`.trim() } : null,
			link: t.linkType ? { type: t.linkType, id: t.linkId } : null,
		};
	}
}
export const adminTasksService = new AdminTasksService();
