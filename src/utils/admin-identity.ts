import { AccountType, UserRole } from '@prisma/client';

/**
 * The identity an ADMIN / SUPER_ADMIN account PRESENTS to the app. The stored `activeRole` of these accounts is often CLIENT (the account-management code maps every non-provider,
 * non-marketer account type to CLIENT), so the app used to draw the client shell and offer a role switch that cannot work. The server authorizes admin access by ACCOUNT TYPE, never by
 * this field, so presenting the truth grants nothing. Rules (pinned by tests):
 *  - an ADMIN account acts as ADMIN, a SUPER_ADMIN account as SUPER_ADMIN - never the other, never CLIENT;
 *  - the presented `roles` are the stored ones plus that single role (nothing is written to the database, and ADMIN is never shown SUPER_ADMIN);
 *  - every other account type is returned unchanged.
 */
export function adminRoleOfAccountType(accountType: AccountType | string | null | undefined): UserRole | null {
	if (accountType === AccountType.SUPER_ADMIN) return UserRole.SUPER_ADMIN;
	if (accountType === AccountType.ADMIN) return UserRole.ADMIN;
	return null;
}

export const isAdminAccountType = (accountType: AccountType | string | null | undefined): boolean => adminRoleOfAccountType(accountType) !== null;

export function presentedIdentity<R extends UserRole>(user: { accountType: AccountType | string; activeRole: R | UserRole; roles: Array<R | UserRole> | null | undefined }): { activeRole: UserRole; roles: UserRole[] } {
	const admin = adminRoleOfAccountType(user.accountType);
	if (!admin) return { activeRole: user.activeRole as UserRole, roles: (user.roles ?? []) as UserRole[] };
	return { activeRole: admin, roles: Array.from(new Set([admin, ...((user.roles ?? []) as UserRole[])])) };
}
