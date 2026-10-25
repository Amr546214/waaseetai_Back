/**
 * For tests of admin HANDLERS (not of the guard): spread into a mocked `prisma` so that every ADMIN account is an ACTIVE staff member whose role holds every permission and the real permission
 * guard lets the request through (a SUPER_ADMIN account needs no database rows at all). The guard itself is tested in admin-guard.matrix.test.ts and admin-team.pg.test.ts with real roles.
 * Never imported by production code.
 */
import { ADMIN_PERMISSION_IDS } from '../config/admin-permissions';

export const fullAccessModels = (onlyUserIds?: string[]) => ({
	adminStaff: { findUnique: async ({ where }: any) => (!onlyUserIds || onlyUserIds.includes(where.userId) ? { id: `staff-${where.userId}`, status: 'ACTIVE', roleId: 'role-all', scoped: false, departments: [], overrides: [], role: { id: 'role-all', name: 'full', permissions: [...ADMIN_PERMISSION_IDS] } } : null) },
});
