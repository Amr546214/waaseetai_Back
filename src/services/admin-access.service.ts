import { AccountType, AdminStaffStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { ADMIN_PERMISSION_IDS, isKnownPermission } from '../config/admin-permissions';
import { ADMIN_NOTIFY_EVENT_PERMISSION, adminNotifyType } from '../config/admin-notification-permissions';

/**
 * Who may do what in the admin API. Read on EVERY admin request straight from the database (no cache, no token claim): withdrawing a permission, changing a role or suspending a
 * staff member therefore applies to the very next request, also for an old session or tab. Anything that cannot be established means NO access (the caller turns a thrown error into a refusal).
 *
 *  - the platform owner (one row in platform_owner) holds every permission and the owner-only capabilities;
 *  - a staff member holds exactly the permissions of their role, while their staff row is ACTIVE;
 *  - an ADMIN / SUPER_ADMIN account with neither holds nothing: the account type grants NO access by itself;
 *  - any other account type holds nothing and is never looked up.
 */
export interface AdminActor {
	userId: string;
	isOwner: boolean;
	staffId: string | null;
	staffStatus: AdminStaffStatus | null;
	roleId: string | null;
	roleName: string | null;
	permissions: ReadonlySet<string>;
}

export const NO_ACCESS = (userId: string): AdminActor => ({ userId, isOwner: false, staffId: null, staffStatus: null, roleId: null, roleName: null, permissions: new Set() });

const ALL = new Set<string>(ADMIN_PERMISSION_IDS);
const isAdminType = (t: unknown) => t === AccountType.ADMIN || t === AccountType.SUPER_ADMIN;

export async function resolveAdminActor(userId: string, accountType: unknown, db: typeof defaultPrisma = defaultPrisma): Promise<AdminActor> {
	if (!isAdminType(accountType)) return NO_ACCESS(userId);
	const [owner, staff] = await Promise.all([
		db.platformOwner.findUnique({ where: { userId }, select: { userId: true } }),
		db.adminStaff.findUnique({ where: { userId }, select: { id: true, status: true, roleId: true, role: { select: { id: true, name: true, permissions: true } } } }),
	]);
	if (owner) {
		// the owner is not locked out by a missing / suspended staff row, and never needs one
		return { userId, isOwner: true, staffId: staff?.id ?? null, staffStatus: staff?.status ?? null, roleId: null, roleName: 'المالك', permissions: ALL };
	}
	if (!staff) return NO_ACCESS(userId);
	if (staff.status !== AdminStaffStatus.ACTIVE || !staff.role) return { ...NO_ACCESS(userId), staffId: staff.id, staffStatus: staff.status, roleId: staff.roleId };
	// ids that are no longer in the registry are ignored, never trusted
	const perms = new Set(staff.role.permissions.filter(isKnownPermission));
	return { userId, isOwner: false, staffId: staff.id, staffStatus: staff.status, roleId: staff.role.id, roleName: staff.role.name, permissions: perms };
}

export const actorHas = (actor: AdminActor, ...ids: string[]) => ids.every(id => actor.permissions.has(id));
export const actorHasAny = (actor: AdminActor, ...ids: string[]) => ids.some(id => actor.permissions.has(id));

/** A task / dispute / ticket may only be handed to somebody who ALREADY holds the permission that the work needs: assigning never grants anything. */
export async function assigneeHolds(userId: string, ids: string[], db: typeof defaultPrisma = defaultPrisma): Promise<boolean> {
	const u = await db.user.findUnique({ where: { id: userId }, select: { accountType: true, status: true } });
	if (!u || u.status !== 'ACTIVE') return false;
	const actor = await resolveAdminActor(userId, u.accountType, db);
	return actorHas(actor, ...ids);
}

/** The platform owner's account cannot be suspended, re-roled, deleted or demoted by ANY route (admin users list, brokers, team, public account paths). Independent of the account type. */
export const OWNER_PROTECTED_CODE = 'OWNER_PROTECTED';
export async function isPlatformOwner(userId: string, db: { platformOwner: { findUnique: (a: any) => Promise<unknown> } } = defaultPrisma): Promise<boolean> {
	return !!(await db.platformOwner.findUnique({ where: { userId }, select: { userId: true } }));
}

/**
 * Entry points outside /admin (assistant, knowledge) that treat an 'admin' actor as privileged ask this first: an ADMIN / SUPER_ADMIN account is privileged there only while it is the owner
 * or an ACTIVE staff member holding at least one permission. Unplaced, suspended or access-less admin accounts get nothing, and so does a failed lookup.
 */
export async function adminHasAnyAccess(userId: string, db: typeof defaultPrisma = defaultPrisma): Promise<boolean> {
	try {
		const u = await db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		const a = await resolveAdminActor(userId, u?.accountType, db);
		return a.isOwner || a.permissions.size > 0;
	} catch { return false; }
}

/** Active owner / staff who hold `permission` right now: the only people an admin notification about that kind of work may reach. */
export async function adminRecipientsHolding(permission: string, db: typeof defaultPrisma = defaultPrisma): Promise<string[]> {
	if (!isKnownPermission(permission)) return [];
	const live = { status: 'ACTIVE' as const, isBanned: false };
	const [owner, staff] = await Promise.all([
		db.platformOwner.findFirst({ where: { user: live }, select: { userId: true } }),
		db.adminStaff.findMany({ where: { status: AdminStaffStatus.ACTIVE, role: { permissions: { has: permission } }, user: live }, select: { userId: true } }),
	]);
	return [...new Set([...(owner ? [owner.userId] : []), ...staff.map(s => s.userId)])];
}

/** The admin notification types this user must NOT see now (they lack the permission, or access cannot be established: fail closed). */
export async function deniedAdminNotificationTypes(userId: string, db: typeof defaultPrisma = defaultPrisma): Promise<string[]> {
	const all = (Object.keys(ADMIN_NOTIFY_EVENT_PERMISSION) as Array<keyof typeof ADMIN_NOTIFY_EVENT_PERMISSION>);
	try {
		const u = await db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		if (!isAdminType(u?.accountType)) return []; // only admin-type accounts ever receive these; nobody else pays for the lookup
		const actor = await resolveAdminActor(userId, u?.accountType, db);
		return all.filter(e => !actor.permissions.has(ADMIN_NOTIFY_EVENT_PERMISSION[e])).map(adminNotifyType);
	} catch { return all.map(adminNotifyType); }
}
