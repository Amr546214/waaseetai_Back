import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { ADMIN_PERMISSIONS, isKnownPermission } from '../config/admin-permissions';
import { AppError, fieldError } from '../utils/app-error';

export const ROLE_VERSION_CONFLICT = 'ROLE_VERSION_CONFLICT';
export const SENSITIVE_CONFIRMATION_REQUIRED = 'SENSITIVE_CONFIRMATION_REQUIRED';
const SENSITIVE = new Set(ADMIN_PERMISSIONS.filter(p => p.sensitive).map(p => p.id));

export interface RoleInput { name?: string; description?: string | null; color?: string; permissions?: string[] }

const cleanName = (n: unknown): string => {
	const v = String(n ?? '').trim().replace(/\s+/g, ' ');
	if (v.length < 2 || v.length > 80) throw fieldError('name', 'اسم الدور يجب أن يكون بين حرفين و80 حرفًا');
	return v;
};
const cleanPerms = (list: unknown): string[] => {
	if (!Array.isArray(list)) throw fieldError('permissions', 'قائمة الصلاحيات غير صالحة');
	const out = Array.from(new Set(list.map(String)));
	const bad = out.filter(id => !isKnownPermission(id));
	if (bad.length) throw fieldError('permissions', 'صلاحية غير معروفة في القائمة');
	return out.sort();
};
const cleanColor = (c: unknown): string => { const v = String(c ?? '#2BD4C7'); if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw fieldError('color', 'اللون غير صالح'); return v; };

export async function writeAccessAudit(tx: Prisma.TransactionClient | typeof defaultPrisma, e: { actorId: string; action: string; subjectUserId?: string | null; roleId?: string | null; inviteId?: string | null; before?: unknown; after?: unknown }) {
	await tx.adminAccessAudit.create({ data: { actorId: e.actorId, action: e.action, subjectUserId: e.subjectUserId ?? null, roleId: e.roleId ?? null, inviteId: e.inviteId ?? null, before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined, after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined } });
}

export class AdminRolesService {
	constructor(private db: typeof defaultPrisma = defaultPrisma) {}

	async list() {
		const roles = await this.db.adminRole.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { staff: true } } } });
		return roles.map(r => ({ id: r.id, name: r.name, description: r.description, color: r.color, permissions: r.permissions, permissionCount: r.permissions.length, memberCount: r._count.staff, version: r.version, updatedAt: r.updatedAt }));
	}

	async create(actorId: string, input: RoleInput) {
		const name = cleanName(input.name), permissions = cleanPerms(input.permissions ?? []);
		const description = input.description ? String(input.description).slice(0, 300) : null, color = cleanColor(input.color);
		try {
			return await this.db.$transaction(async tx => {
				const role = await tx.adminRole.create({ data: { name, nameKey: name.toLowerCase(), description, color, permissions, createdById: actorId } });
				await writeAccessAudit(tx, { actorId, action: 'ROLE_CREATED', roleId: role.id, after: { name, permissions } });
				return role;
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw fieldError('name', 'يوجد دور بهذا الاسم', 409);
			throw e;
		}
	}

	/** What saving would change, before anything is saved: the owner sees it (and the sensitive ones) first. */
	async preview(id: string, permissions: unknown) {
		const role = await this.db.adminRole.findUnique({ where: { id }, include: { _count: { select: { staff: true } } } });
		if (!role) throw new AppError('الدور غير موجود', 404);
		const next = new Set(cleanPerms(permissions));
		const before = new Set(role.permissions);
		const added = [...next].filter(p => !before.has(p)), removed = [...before].filter(p => !next.has(p));
		return { roleId: id, version: role.version, added, removed, addedSensitive: added.filter(p => SENSITIVE.has(p)), affectedMembers: role._count.staff };
	}

	async update(actorId: string, id: string, input: RoleInput & { expectedVersion?: number; confirmSensitive?: boolean }) {
		if (!Number.isInteger(input.expectedVersion)) throw fieldError('expectedVersion', 'رقم نسخة الدور مطلوب لمنع استبدال تعديل أحدث');
		const current = await this.db.adminRole.findUnique({ where: { id }, include: { staff: { select: { userId: true } } } });
		if (!current) throw new AppError('الدور غير موجود', 404);
		const data: Prisma.AdminRoleUpdateManyMutationInput = {};
		if (input.name !== undefined) { const n = cleanName(input.name); data.name = n; data.nameKey = n.toLowerCase(); }
		if (input.description !== undefined) data.description = input.description ? String(input.description).slice(0, 300) : null;
		if (input.color !== undefined) data.color = cleanColor(input.color);
		let added: string[] = [], removed: string[] = [];
		if (input.permissions !== undefined) {
			const next = cleanPerms(input.permissions); const before = new Set(current.permissions);
			added = next.filter(p => !before.has(p)); removed = [...before].filter(p => !next.includes(p));
			data.permissions = next;
			if (added.some(p => SENSITIVE.has(p)) && input.confirmSensitive !== true) {
				throw new AppError('منح صلاحية حساسة يحتاج تأكيدًا صريحًا', 409, [{ addedSensitive: added.filter(p => SENSITIVE.has(p)) }], SENSITIVE_CONFIRMATION_REQUIRED);
			}
		}
		try {
			return await this.db.$transaction(async tx => {
				const res = await tx.adminRole.updateMany({ where: { id, version: input.expectedVersion }, data: { ...data, version: { increment: 1 } } });
				if (res.count === 0) throw new AppError('عُدّل هذا الدور من جهة أخرى قبل حفظك. أعد التحميل وراجع التغيير.', 409, undefined, ROLE_VERSION_CONFLICT);
				await writeAccessAudit(tx, { actorId, action: 'ROLE_UPDATED', roleId: id, before: { name: current.name, permissions: current.permissions }, after: { name: data.name ?? current.name, permissionsAdded: added, permissionsRemoved: removed, affectedMembers: current.staff.map(s => s.userId) } });
				return tx.adminRole.findUniqueOrThrow({ where: { id } });
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw fieldError('name', 'يوجد دور بهذا الاسم', 409);
			throw e;
		}
	}
}
export const adminRolesService = new AdminRolesService();
