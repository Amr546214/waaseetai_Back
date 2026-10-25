/**
 * For tests of admin HANDLERS (not of the guard): spread into a mocked `prisma` so that every admin-type account is the platform owner and the real permission guard lets the request
 * through. The guard itself is tested in admin-guard.matrix.test.ts and admin-team.pg.test.ts with real roles. Never imported by production code.
 */
export const ownerModels = (onlyUserIds?: string[]) => ({
	platformOwner: { findUnique: async ({ where }: any) => (!onlyUserIds || onlyUserIds.includes(where.userId) ? { userId: where.userId } : null) },
	adminStaff: { findUnique: async () => null },
});
