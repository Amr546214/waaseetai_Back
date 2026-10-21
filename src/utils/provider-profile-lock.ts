/**
 * Serialises everything that decides or re-opens a provider's identity review (the admin's KYC decision, the decision on a new document request, the provider's
 * confirmation of a corrected document) on the SAME provider_profiles row: the second one waits for the first one's commit and then sees its result.
 * Without it an admin could approve the OLD document at the very moment the provider confirms a NEW one. Must be called first inside an interactive transaction.
 */
export const lockProviderProfile = async (tx: { $queryRaw?: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }, userId: string): Promise<void> => {
	// a real Prisma transaction always has $queryRaw; the guard only lets the small in-memory fakes of older unit tests through (the PostgreSQL tests exercise the real lock)
	if (typeof tx.$queryRaw !== 'function') return;
	await tx.$queryRaw`SELECT 1 FROM provider_profiles WHERE "userId" = ${userId} FOR UPDATE`;
};
