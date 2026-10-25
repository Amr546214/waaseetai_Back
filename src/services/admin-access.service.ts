import { AccountType, AdminStaffStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { ADMIN_PERMISSION_IDS, applyDepartmentScope, isKnownPermission } from '../config/admin-permissions';
import { ADMIN_NOTIFY_EVENT_PERMISSION, adminNotifyType } from '../config/admin-notification-permissions';

/**
 * Who may do what in the admin API. Read on EVERY admin request straight from the database (no cache, no token claim): withdrawing a permission, changing a role, a personal change or
 * suspending a staff member therefore applies to the very next request, also for an old session or tab. Anything that cannot be established means NO access (the caller turns a thrown
 * error into a refusal).
 *
 *  - a SUPER_ADMIN account (the type read from the database row, never from a token, a header or a hard-coded e-mail) holds every permission and the SUPER_ADMIN-only capabilities;
 *  - an ADMIN account is a staff member: it holds (role + personal GRANTs - personal DENYs), narrowed by its section scope, while its staff row is ACTIVE;
 *  - an ADMIN account without a staff row / without a role holds nothing: the account type ADMIN grants NO access by itself;
 *  - any other account type holds nothing and is never looked up.
 */
export interface AdminActor {
	userId: string;
	isSuperAdmin: boolean;
	staffId: string | null;
	staffStatus: AdminStaffStatus | null;
	roleId: string | null;
	roleName: string | null;
	permissions: ReadonlySet<string>;
}

export const NO_ACCESS = (userId: string): AdminActor => ({ userId, isSuperAdmin: false, staffId: null, staffStatus: null, roleId: null, roleName: null, permissions: new Set() });

const ALL = new Set<string>(ADMIN_PERMISSION_IDS);
const isAdminType = (t: unknown) => t === AccountType.ADMIN || t === AccountType.SUPER_ADMIN;

/** What a staff member holds: (role + GRANT) - DENY, narrowed by the section scope. A DENY always beats the role; ids that are not in the registry are ignored. Pure, so the UI and the guard agree. */
export function computeEffectivePermissions(rolePermissions: readonly string[], overrides: ReadonlyArray<{ permission: string; effect: string }>, scoped: boolean, departments: readonly string[]): Set<string> {
	const set = new Set(rolePermissions.filter(isKnownPermission));
	for (const o of overrides) if (o.effect === 'GRANT' && isKnownPermission(o.permission)) set.add(o.permission);
	for (const o of overrides) if (o.effect === 'DENY') set.delete(o.permission);
	return applyDepartmentScope(set, scoped, departments);
}

export async function resolveAdminActor(userId: string, accountType: unknown, db: typeof defaultPrisma = defaultPrisma): Promise<AdminActor> {
	if (!isAdminType(accountType)) return NO_ACCESS(userId);
	if (accountType === AccountType.SUPER_ADMIN) return { userId, isSuperAdmin: true, staffId: null, staffStatus: null, roleId: null, roleName: 'Super Admin', permissions: ALL };
	const staff = await db.adminStaff.findUnique({ where: { userId }, select: { id: true, status: true, roleId: true, scoped: true, departments: true, overrides: { select: { permission: true, effect: true } }, role: { select: { id: true, name: true, permissions: true } } } });
	if (!staff) return NO_ACCESS(userId);
	if (staff.status !== AdminStaffStatus.ACTIVE || !staff.role) return { ...NO_ACCESS(userId), staffId: staff.id, staffStatus: staff.status, roleId: staff.roleId };
	const perms = computeEffectivePermissions(staff.role.permissions, staff.overrides ?? [], staff.scoped, staff.departments ?? []);
	return { userId, isSuperAdmin: false, staffId: staff.id, staffStatus: staff.status, roleId: staff.role.id, roleName: staff.role.name, permissions: perms };
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

/**
 * Entry points outside /admin (assistant, knowledge) that treat an 'admin' actor as privileged ask this first: an ADMIN / SUPER_ADMIN account is privileged there only while it is a SUPER_ADMIN
 * or an ACTIVE staff member holding at least one permission. Unplaced, suspended or access-less admin accounts get nothing, and so does a failed lookup.
 */
/**
 * The remote AI service (assistant chat / tools / voice / knowledge search) is given the general role `admin` for an administrator, and it decides document access by that role on ITS side where the
 * staff member's permissions and sections cannot be enforced. So the privileged remote search is SUPER_ADMIN-only: a staff member (ADMIN account), whatever the role / grants / sections, is refused
 * there until the scope can be enforced end to end. Reads the type from the database; any failure = refused.
 */
export async function adminMayUseRemoteAi(userId: string, db: typeof defaultPrisma = defaultPrisma): Promise<boolean> {
	try {
		const u = await db.user.findUnique({ where: { id: userId }, select: { accountType: true, status: true } });
		return u?.accountType === AccountType.SUPER_ADMIN && u.status === 'ACTIVE';
	} catch { return false; }
}

export async function adminHasAnyAccess(userId: string, db: typeof defaultPrisma = defaultPrisma): Promise<boolean> {
	try {
		const u = await db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		const a = await resolveAdminActor(userId, u?.accountType, db);
		return a.isSuperAdmin || a.permissions.size > 0;
	} catch { return false; }
}

/** Live SUPER_ADMIN accounts and ACTIVE staff who hold `permission` right now: the only people an admin notification about that kind of work may reach. */
export async function adminRecipientsHolding(permission: string, db: typeof defaultPrisma = defaultPrisma): Promise<string[]> {
	if (!isKnownPermission(permission)) return [];
	const live = { status: 'ACTIVE' as const, isBanned: false };
	const [supers, staff] = await Promise.all([
		db.user.findMany({ where: { accountType: AccountType.SUPER_ADMIN, ...live }, select: { id: true } }),
		db.adminStaff.findMany({ where: { status: AdminStaffStatus.ACTIVE, user: live }, select: { userId: true, scoped: true, departments: true, overrides: { select: { permission: true, effect: true } }, role: { select: { permissions: true } } } }),
	]);
	const holders = staff.filter(s => s.role && computeEffectivePermissions(s.role.permissions, s.overrides, s.scoped, s.departments).has(permission)).map(s => s.userId);
	return [...new Set([...supers.map(u => u.id), ...holders])];
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
